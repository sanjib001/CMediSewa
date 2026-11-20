-- =============================================================================
-- 0005 POSTING CORE: idempotent postings, gapless numbering, double-entry journal
-- database.md §11.6, §12; decisions D-39, D-43, D-44, D-45, D-53.
--
-- Every later document that moves money (and, from B5, stock) is ONE transaction:
--   begin_posting()       → the postings row (idempotency key; a retry returns the original)
--   next_document_no()    → its number (gapless per tenant × doc type × scope × fiscal year)
--   <document rows>
--   post_journal()        → balanced ledger_entries (checked immediately AND at commit)
-- and nothing else may write the journal:
--   * ledger_entries / postings / document_sequences accept writes only from functions
--     owned by the non-login role `ledger_writer` (SECURITY DEFINER);
--   * service_role (the app's key) can READ them, never write them (D-39);
--   * the primitives here are NOT executable by service_role. Only document RPCs (B4+),
--     themselves owned by ledger_writer, call them. That is what makes "every journal
--     line belongs to a real document" structural instead of a convention.
-- =============================================================================

-- ── the writer role ───────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ledger_writer') then
    -- BYPASSRLS: these tables are RLS-on with no policies (deny-all backstop); the writer
    -- is the one role allowed through, just as service_role is for ordinary tables.
    create role ledger_writer nologin bypassrls;
  end if;
end $$;
comment on role ledger_writer is
  'Owner of the posting functions. The ONLY role that can write postings, ledger_entries and document_sequences (and stock_movements from B5). Never used to log in.';
-- The migrating role must be a member to hand function ownership to it.
grant ledger_writer to current_user;
grant usage on schema public to ledger_writer;

-- ── chart of accounts (fixed system chart per tenant, database.md §12) ────────
create table ledger_accounts (
  tenant_id   uuid not null references tenants (id) on delete restrict,
  code        text not null check (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  name        text not null,
  type        text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  is_system   boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, code)
);
comment on table ledger_accounts is
  'Fixed system chart of accounts, seeded for every tenant on creation. Not user-editable in the MVP (D-43).';

create or replace function seed_ledger_accounts(p_tenant uuid)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into ledger_accounts (tenant_id, code, name, type) values
    (p_tenant, 'CASH',                 'Cash in hand',                      'asset'),
    (p_tenant, 'BANK',                 'Bank / online / wallet / card',     'asset'),
    (p_tenant, 'AR_PATIENTS',          'Receivables: patient dues',         'asset'),
    (p_tenant, 'INVENTORY',            'Inventory at cost',                 'asset'),
    (p_tenant, 'INVENTORY_IN_TRANSIT', 'Inventory in transit',              'asset'),
    (p_tenant, 'VENDOR_ADVANCES',      'Advances paid to vendors',          'asset'),
    (p_tenant, 'TAX_RECEIVABLE',       'Recoverable input tax',             'asset'),
    (p_tenant, 'AP_VENDORS',           'Payables: vendors',                 'liability'),
    (p_tenant, 'TAX_PAYABLE',          'Output tax payable',                'liability'),
    (p_tenant, 'PATIENT_ADVANCES',     'Patient deposits not yet applied',  'liability'),
    (p_tenant, 'OPENING_EQUITY',       'Opening balances',                  'equity'),
    (p_tenant, 'REV_SERVICES',         'Revenue: services and OPD',         'income'),
    (p_tenant, 'REV_PHARMACY',         'Revenue: pharmacy',                 'income'),
    (p_tenant, 'REV_OTHER',            'Other income',                      'income'),
    (p_tenant, 'INV_GAIN',             'Inventory gains (found, surplus)',  'income'),
    (p_tenant, 'COGS',                 'Cost of goods sold',                'expense'),
    (p_tenant, 'INV_LOSS',             'Inventory losses',                  'expense'),
    (p_tenant, 'ROUNDING',             'Rounding',                          'expense'),
    (p_tenant, 'EXP_RENT',             'Rent',                              'expense'),
    (p_tenant, 'EXP_ELECTRICITY',      'Electricity',                       'expense'),
    (p_tenant, 'EXP_WATER',            'Water',                             'expense'),
    (p_tenant, 'EXP_INTERNET',         'Internet and phone',                'expense'),
    (p_tenant, 'EXP_SALARY',           'Salaries',                          'expense'),
    (p_tenant, 'EXP_MAINTENANCE',      'Maintenance',                       'expense'),
    (p_tenant, 'EXP_MARKETING',        'Marketing',                         'expense'),
    (p_tenant, 'EXP_LICENSES',         'Licences and fees',                 'expense'),
    (p_tenant, 'EXP_TRANSPORT',        'Transport',                         'expense'),
    (p_tenant, 'EXP_CLEANING',         'Cleaning',                          'expense'),
    (p_tenant, 'EXP_MEDICAL_WASTE',    'Medical waste disposal',            'expense'),
    (p_tenant, 'EXP_OTHER',            'Other expenses',                    'expense')
  on conflict do nothing;
$$;

create or replace function tenants_seed_accounts()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform seed_ledger_accounts(new.id);
  return new;
end;
$$;
create trigger tenants_seed_accounts after insert on tenants
  for each row execute function tenants_seed_accounts();

-- ── document numbering ────────────────────────────────────────────────────────
create table document_sequences (
  tenant_id    uuid not null references tenants (id) on delete restrict,
  doc_type     text not null check (doc_type ~ '^[a-z_]{2,40}$'),
  scope_id     uuid not null,
  fiscal_year  text not null references fiscal_years (code),
  next_no      bigint not null check (next_no >= 1),
  primary key (tenant_id, doc_type, scope_id, fiscal_year)
);
comment on table document_sequences is
  'Gapless counters. scope_id = billing profile for invoices/receipts/sale returns (D-49), tenant id otherwise. Locked by the upsert inside the posting transaction; a rollback releases the number too.';
comment on column document_sequences.scope_id is
  'Not a composite FK on purpose: it points at a billing profile OR the tenant, depending on doc_type. next_document_no() validates it.';

-- ── postings ──────────────────────────────────────────────────────────────────
create table postings (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants (id) on delete restrict,
  idempotency_key      uuid not null,
  doc_type             text not null check (doc_type ~ '^[a-z_]{2,40}$'),
  doc_id               uuid,
  posted_by            uuid,
  session_level        text check (session_level in ('A1', 'A2', 'A3')),
  device_id            uuid,
  posted_at            timestamptz not null default now(),
  reverses_posting_id  uuid unique,
  unique (tenant_id, id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, reverses_posting_id) references postings (tenant_id, id)
);
comment on table postings is
  'One row per stock/money change (D-44). The idempotency key makes retries (double taps, flaky networks, PWA resubmits) return the original result. Immutable; a correction is a new posting that reverses_posting_id the old one, at most once.';
comment on column postings.posted_by is 'tenant_members.id; FK added with tenant_members (B1).';

-- ── journal ───────────────────────────────────────────────────────────────────
create table ledger_entries (
  id            bigserial primary key,
  tenant_id     uuid not null,
  posting_id    uuid not null,
  account_code  text not null,
  debit         numeric(14,2) not null default 0 check (debit  >= 0),
  credit        numeric(14,2) not null default 0 check (credit >= 0),
  store_id      uuid,
  vendor_id     uuid,
  patient_id    uuid,
  channel       text check (channel in ('cash', 'esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')),
  doc_type      text not null,
  doc_id        uuid,
  occurred_at   timestamptz not null,
  memo          text,
  check ((debit > 0) <> (credit > 0)),
  foreign key (tenant_id, posting_id)   references postings (tenant_id, id),
  foreign key (tenant_id, account_code) references ledger_accounts (tenant_id, code)
);
create index ledger_entries_posting      on ledger_entries (posting_id);
create index ledger_entries_account_time on ledger_entries (tenant_id, account_code, occurred_at);
create index ledger_entries_store_time   on ledger_entries (tenant_id, store_id, occurred_at) where store_id is not null;
create index ledger_entries_vendor       on ledger_entries (tenant_id, vendor_id)  where vendor_id  is not null;
create index ledger_entries_patient      on ledger_entries (tenant_id, patient_id) where patient_id is not null;
comment on table ledger_entries is
  'Double-entry journal (D-43). Exactly one of debit/credit > 0 per line; Σ debit = Σ credit per posting (deferred check). Balances are sums, so carry-forward cannot drift. store/vendor/patient FKs are added when those tables exist.';

-- Balanced at commit, whatever order the lines were written in.
create or replace function check_posting_balanced()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_dr numeric; v_cr numeric;
begin
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_dr, v_cr
    from ledger_entries where posting_id = new.posting_id;
  if v_dr <> v_cr then
    raise exception 'UNBALANCED_POSTING: posting % debits % credits %', new.posting_id, v_dr, v_cr
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;
create constraint trigger ledger_entries_balanced
  after insert on ledger_entries
  deferrable initially deferred
  for each row execute function check_posting_balanced();

-- Immutability.
create trigger postings_no_update         before update or delete on postings       for each row       execute function forbid_mutation();
create trigger postings_no_truncate       before truncate          on postings       for each statement execute function forbid_mutation();
create trigger ledger_entries_no_update   before update or delete on ledger_entries for each row       execute function forbid_mutation();
create trigger ledger_entries_no_truncate before truncate          on ledger_entries for each statement execute function forbid_mutation();

-- ── primitives (owned by ledger_writer, NOT callable by service_role) ─────────

-- Next number in a series. Upsert = row lock; gapless because it is inside the posting tx.
create or replace function next_document_no(
  p_tenant uuid, p_doc_type text, p_scope uuid, p_at timestamptz default now()
) returns table (fiscal_year text, doc_no bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tz text; v_fy text; v_no bigint;
begin
  select t.timezone into v_tz from tenants t where t.id = p_tenant;
  if v_tz is null then raise exception 'TENANT_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_scope <> p_tenant and not exists (
       select 1 from billing_profiles b where b.tenant_id = p_tenant and b.id = p_scope) then
    raise exception 'SCOPE_NOT_IN_TENANT' using errcode = 'P0001';
  end if;
  v_fy := fiscal_year_of(p_at, v_tz);
  insert into document_sequences as s (tenant_id, doc_type, scope_id, fiscal_year, next_no)
  values (p_tenant, p_doc_type, p_scope, v_fy, 2)
  on conflict (tenant_id, doc_type, scope_id, fiscal_year)
    do update set next_no = s.next_no + 1
  returning s.next_no - 1 into v_no;
  return query select v_fy, v_no;
end;
$$;

-- Start a posting, or return the existing one for a repeated idempotency key.
create or replace function begin_posting(
  p_tenant uuid, p_idempotency_key uuid, p_doc_type text, p_doc_id uuid,
  p_actor uuid, p_session_level text, p_device uuid, p_reverses uuid default null
) returns table (posting_id uuid, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  if p_idempotency_key is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'P0001'; end if;
  insert into postings (tenant_id, idempotency_key, doc_type, doc_id, posted_by, session_level, device_id, reverses_posting_id)
  values (p_tenant, p_idempotency_key, p_doc_type, p_doc_id, p_actor, p_session_level, p_device, p_reverses)
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return query select v_id, false;
    return;
  end if;
  -- Same key seen before: it must be the SAME operation, or the caller has a bug.
  select p.id into v_id from postings p
   where p.tenant_id = p_tenant and p.idempotency_key = p_idempotency_key and p.doc_type = p_doc_type;
  if v_id is null then
    raise exception 'IDEMPOTENCY_KEY_REUSED: key already used for a different document type' using errcode = 'P0001';
  end if;
  return query select v_id, true;
end;
$$;

-- Write the journal lines of a posting, once. Validates before inserting so the caller gets
-- a precise error, and the deferred trigger re-checks at commit.
create or replace function post_journal(p_tenant uuid, p_posting uuid, p_entries jsonb)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_post postings;
  v_dr numeric := 0; v_cr numeric := 0; v_n integer;
begin
  select * into v_post from postings where id = p_posting and tenant_id = p_tenant;
  if not found then raise exception 'POSTING_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from ledger_entries where posting_id = p_posting) then
    raise exception 'POSTING_ALREADY_JOURNALED' using errcode = 'P0001';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) < 2 then
    raise exception 'JOURNAL_NEEDS_TWO_LINES' using errcode = 'P0001';
  end if;
  select coalesce(sum(round(coalesce((e->>'debit')::numeric, 0), 2)), 0),
         coalesce(sum(round(coalesce((e->>'credit')::numeric, 0), 2)), 0)
    into v_dr, v_cr
    from jsonb_array_elements(p_entries) e;
  if v_dr <> v_cr then
    raise exception 'UNBALANCED_POSTING: debits % credits %', v_dr, v_cr using errcode = 'P0001';
  end if;
  insert into ledger_entries (tenant_id, posting_id, account_code, debit, credit,
                              store_id, vendor_id, patient_id, channel, doc_type, doc_id, occurred_at, memo)
  select p_tenant, p_posting, e->>'account',
         round(coalesce((e->>'debit')::numeric, 0), 2), round(coalesce((e->>'credit')::numeric, 0), 2),
         (e->>'store_id')::uuid, (e->>'vendor_id')::uuid, (e->>'patient_id')::uuid, e->>'channel',
         v_post.doc_type, v_post.doc_id, v_post.posted_at, e->>'memo'
    from jsonb_array_elements(p_entries) e;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Exact reversal: a new posting whose lines mirror the original with debit/credit swapped.
-- A posting can be reversed at most once (unique reverses_posting_id); a reversal itself
-- cannot be reversed (re-post the corrected document instead).
create or replace function reverse_posting(
  p_tenant uuid, p_original uuid, p_idempotency_key uuid,
  p_actor uuid, p_session_level text, p_device uuid, p_reason text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_orig postings; v_new uuid; v_replayed boolean;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_orig from postings where id = p_original and tenant_id = p_tenant;
  if not found then raise exception 'POSTING_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_orig.reverses_posting_id is not null then
    raise exception 'CANNOT_REVERSE_REVERSAL' using errcode = 'P0001';
  end if;
  select b.posting_id, b.replayed into v_new, v_replayed
    from begin_posting(p_tenant, p_idempotency_key, 'reversal', v_orig.doc_id,
                       p_actor, p_session_level, p_device, p_original) b;
  if v_replayed then return v_new; end if;
  insert into ledger_entries (tenant_id, posting_id, account_code, debit, credit,
                              store_id, vendor_id, patient_id, channel, doc_type, doc_id, occurred_at, memo)
  select tenant_id, v_new, account_code, credit, debit,
         store_id, vendor_id, patient_id, channel, 'reversal', doc_id, now(),
         'reversal: ' || p_reason
    from ledger_entries where posting_id = p_original;
  return v_new;
end;
$$;

-- ── ownership and privileges ──────────────────────────────────────────────────
-- ALTER … OWNER requires the new owner to hold CREATE on the schema at that moment
-- (42501 otherwise). Granted only around the transfers and revoked straight after, so
-- ledger_writer ends up owning these functions but unable to create anything itself.
grant create on schema public to ledger_writer;
alter function seed_ledger_accounts(uuid)                                                   owner to ledger_writer;
alter function tenants_seed_accounts()                                                      owner to ledger_writer;
alter function next_document_no(uuid, text, uuid, timestamptz)                              owner to ledger_writer;
alter function begin_posting(uuid, uuid, text, uuid, uuid, text, uuid, uuid)                owner to ledger_writer;
alter function post_journal(uuid, uuid, jsonb)                                              owner to ledger_writer;
alter function reverse_posting(uuid, uuid, uuid, uuid, text, uuid, text)                    owner to ledger_writer;
revoke create on schema public from ledger_writer;

revoke all on function seed_ledger_accounts(uuid)                                    from public, anon, authenticated, service_role;
revoke all on function tenants_seed_accounts()                                       from public, anon, authenticated, service_role;
revoke all on function check_posting_balanced()                                      from public, anon, authenticated, service_role;
revoke all on function next_document_no(uuid, text, uuid, timestamptz)               from public, anon, authenticated, service_role;
revoke all on function begin_posting(uuid, uuid, text, uuid, uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function post_journal(uuid, uuid, jsonb)                               from public, anon, authenticated, service_role;
revoke all on function reverse_posting(uuid, uuid, uuid, uuid, text, uuid, text)     from public, anon, authenticated, service_role;

grant select on tenants, billing_profiles, fiscal_years                to ledger_writer;
grant execute on function fiscal_year_of(timestamptz, text)            to ledger_writer;
grant select, insert         on ledger_accounts                        to ledger_writer;
grant select, insert, update on document_sequences                     to ledger_writer;
grant select, insert         on postings, ledger_entries               to ledger_writer;
grant usage, select          on sequence ledger_entries_id_seq         to ledger_writer;
grant insert                 on audit_log                              to ledger_writer;
grant usage, select          on sequence audit_log_id_seq              to ledger_writer;

-- service_role (the app) reads the journal; it never writes it (D-39).
revoke insert, update, delete on ledger_accounts, document_sequences, postings, ledger_entries from service_role;
revoke usage on sequence ledger_entries_id_seq from service_role;

alter table ledger_accounts    enable row level security;
alter table document_sequences enable row level security;
alter table postings           enable row level security;
alter table ledger_entries     enable row level security;
