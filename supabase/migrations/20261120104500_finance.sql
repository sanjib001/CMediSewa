-- =============================================================================
-- 0046 FINANCE (B8a): expenses and other income (corrected only by reversal), opening cash and
-- bank, the finance report (balances + flows from the journal), profit and loss, the daily
-- summary, and verify_finance_integrity (documents vs journal; never repairs), run nightly.
-- database.md §12; workflows W-17; decisions D-108..D-111.
-- =============================================================================

create table expenses (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete restrict,
  expense_no      text not null,
  fiscal_year     text not null,
  category        text not null check (category in ('rent', 'electricity', 'water', 'internet', 'salary', 'maintenance', 'marketing',
                                                     'licenses', 'transport', 'cleaning', 'medical_waste', 'other')),
  amount          numeric(12,2) not null check (amount > 0),
  cash_amount     numeric(12,2) not null default 0 check (cash_amount >= 0),
  online_amount   numeric(12,2) not null default 0 check (online_amount >= 0),
  online_channel  text check (online_channel in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')),
  store_id        uuid,
  note            text check (length(note) <= 300),
  recorded_by     uuid not null,
  recorded_at     timestamptz not null default now(),
  posting_id      uuid not null,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_year, expense_no),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, recorded_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  check (cash_amount + online_amount = amount),
  check ((online_amount = 0) = (online_channel is null))
);

create table other_income (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete restrict,
  income_no       text not null,
  fiscal_year     text not null,
  description     text not null check (length(btrim(description)) between 3 and 200),
  amount          numeric(12,2) not null check (amount > 0),
  cash_amount     numeric(12,2) not null default 0 check (cash_amount >= 0),
  online_amount   numeric(12,2) not null default 0 check (online_amount >= 0),
  online_channel  text check (online_channel in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')),
  recorded_by     uuid not null,
  recorded_at     timestamptz not null default now(),
  posting_id      uuid not null,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_year, income_no),
  foreign key (tenant_id, recorded_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  check (cash_amount + online_amount = amount),
  check ((online_amount = 0) = (online_channel is null))
);

-- Opening cash and bank, once per clinic (at go-live). Stock and vendor openings have their own.
create table finance_openings (
  tenant_id    uuid primary key references tenants (id) on delete restrict,
  cash_amount  numeric(14,2) not null default 0 check (cash_amount >= 0),
  bank_amount  numeric(14,2) not null default 0 check (bank_amount >= 0),
  as_of        date not null,
  recorded_by  uuid not null,
  recorded_at  timestamptz not null default now(),
  posting_id   uuid not null,
  foreign key (tenant_id, recorded_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id)
);

create table finance_checks (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants (id) on delete restrict,
  ran_at      timestamptz not null default now(),
  mismatches  integer not null,
  checks      jsonb not null
);
create index finance_checks_recent on finance_checks (tenant_id, ran_at desc);

alter table expenses         enable row level security;
alter table other_income     enable row level security;
alter table finance_openings enable row level security;
alter table finance_checks   enable row level security;
revoke insert, update, delete on expenses, other_income, finance_openings, finance_checks from service_role;

-- ── helpers ───────────────────────────────────────────────────────────────────
-- A period of business days [from, to] as instants (clinic time zone, day_closing_hour).
create or replace function finance_range(p_tenant uuid, p_from date, p_to date, out t0 timestamptz, out t1 timestamptz)
language sql stable
set search_path = pg_catalog, public
as $$
  select (p_from::timestamp + make_interval(hours => s.day_closing_hour)) at time zone t.timezone,
         ((p_to + 1)::timestamp + make_interval(hours => s.day_closing_hour)) at time zone t.timezone
    from tenants t join tenant_settings s on s.tenant_id = t.id where t.id = p_tenant;
$$;

-- Σ (debit − credit) of an account before an instant.
create or replace function account_balance(p_tenant uuid, p_account text, p_before timestamptz)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce(sum(debit - credit), 0) from ledger_entries where tenant_id = p_tenant and account_code = p_account and occurred_at < p_before;
$$;

-- Was this posting reversed?
create or replace function posting_reversed(p_posting uuid)
returns boolean
language sql stable
set search_path = pg_catalog, public
as $$ select exists (select 1 from postings where reverses_posting_id = p_posting); $$;

-- ── expenses and other income ─────────────────────────────────────────────────
-- Recorded now (no back-dating). Journal: Dr EXP_<category> / Cr CASH, BANK.
create or replace function record_expense(
  p_tenant uuid, p_idempotency_key uuid, p_category text, p_cash numeric, p_online numeric, p_channel text, p_store uuid, p_note text,
  p_by uuid, p_session_level text, p_device uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text; v_cash numeric := round(coalesce(p_cash, 0), 2);
        v_online numeric := round(coalesce(p_online, 0), 2); v_entries jsonb;
begin
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'add_expenses') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if p_category not in ('rent', 'electricity', 'water', 'internet', 'salary', 'maintenance', 'marketing', 'licenses', 'transport', 'cleaning', 'medical_waste', 'other') then
    raise exception 'BAD_CATEGORY' using errcode = 'P0001';
  end if;
  if v_cash < 0 or v_online < 0 or v_cash + v_online <= 0 then raise exception 'BAD_AMOUNT' using errcode = 'P0001'; end if;
  if v_online > 0 and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  if p_store is not null and not exists (select 1 from stores where id = p_store and tenant_id = p_tenant) then raise exception 'STORE_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_category = 'other' and coalesce(btrim(p_note), '') = '' then raise exception 'NOTE_REQUIRED' using errcode = 'P0001'; end if;
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'expense', v_id, p_by, p_session_level, p_device) b;
  if v_replayed then return (select jsonb_build_object('expense_id', e.id, 'expense_no', e.expense_no, 'replayed', true) from expenses e where e.posting_id = v_post); end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'expense', 'EXP') d;
  insert into expenses (id, tenant_id, expense_no, fiscal_year, category, amount, cash_amount, online_amount, online_channel, store_id, note, recorded_by, posting_id)
  values (v_id, p_tenant, v_no, v_fy, p_category, v_cash + v_online, v_cash, v_online, case when v_online > 0 then p_channel end, p_store, nullif(btrim(p_note), ''), p_by, v_post);
  v_entries := jsonb_build_array(jsonb_build_object('account', 'EXP_' || upper(p_category), 'debit', v_cash + v_online, 'store_id', p_store, 'memo', v_no));
  if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'credit', v_cash, 'channel', 'cash', 'memo', v_no); end if;
  if v_online > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'credit', v_online, 'channel', p_channel, 'memo', v_no); end if;
  perform post_journal(p_tenant, v_post, v_entries);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'expense.record', 'expense', v_id::text, 'success', jsonb_build_object('no', v_no, 'category', p_category, 'amount', v_cash + v_online));
  return jsonb_build_object('expense_id', v_id, 'expense_no', v_no, 'replayed', false);
end $$;

-- Journal: Dr CASH, BANK / Cr REV_OTHER. Needs manage_expenses and a password session.
create or replace function record_other_income(
  p_tenant uuid, p_idempotency_key uuid, p_description text, p_cash numeric, p_online numeric, p_channel text,
  p_by uuid, p_session_level text, p_device uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text; v_cash numeric := round(coalesce(p_cash, 0), 2);
        v_online numeric := round(coalesce(p_online, 0), 2); v_entries jsonb;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_expenses') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_description, ''))) < 3 then raise exception 'DESCRIPTION_REQUIRED' using errcode = 'P0001'; end if;
  if v_cash < 0 or v_online < 0 or v_cash + v_online <= 0 then raise exception 'BAD_AMOUNT' using errcode = 'P0001'; end if;
  if v_online > 0 and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'other_income', v_id, p_by, p_session_level, p_device) b;
  if v_replayed then return (select jsonb_build_object('income_id', i.id, 'income_no', i.income_no, 'replayed', true) from other_income i where i.posting_id = v_post); end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'other_income', 'INC') d;
  insert into other_income (id, tenant_id, income_no, fiscal_year, description, amount, cash_amount, online_amount, online_channel, recorded_by, posting_id)
  values (v_id, p_tenant, v_no, v_fy, btrim(p_description), v_cash + v_online, v_cash, v_online, case when v_online > 0 then p_channel end, p_by, v_post);
  v_entries := jsonb_build_array(jsonb_build_object('account', 'REV_OTHER', 'credit', v_cash + v_online, 'memo', v_no));
  if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'debit', v_cash, 'channel', 'cash', 'memo', v_no); end if;
  if v_online > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'debit', v_online, 'channel', p_channel, 'memo', v_no); end if;
  perform post_journal(p_tenant, v_post, v_entries);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'income.record', 'other_income', v_id::text, 'success', jsonb_build_object('no', v_no, 'amount', v_cash + v_online));
  return jsonb_build_object('income_id', v_id, 'income_no', v_no, 'replayed', false);
end $$;

-- Correct an expense or other income: the original stays, a reversal cancels it (then the
-- right one is recorded as new). manage_expenses + password confirmed in the last 5 minutes.
create or replace function reverse_finance_entry(
  p_tenant uuid, p_idempotency_key uuid, p_kind text, p_id uuid, p_reason text,
  p_by uuid, p_session_level text, p_reauth_at timestamptz, p_device uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_post uuid; v_no text; v_rev uuid;
begin
  if p_session_level not in ('A2', 'A3') or p_reauth_at is null or p_reauth_at < now() - interval '5 minutes' then raise exception 'REAUTH_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_expenses') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if p_kind = 'expense' then select posting_id, expense_no into v_post, v_no from expenses where id = p_id and tenant_id = p_tenant;
  elsif p_kind = 'other_income' then select posting_id, income_no into v_post, v_no from other_income where id = p_id and tenant_id = p_tenant;
  else raise exception 'BAD_KIND' using errcode = 'P0001'; end if;
  if v_post is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if posting_reversed(v_post) then
    select id into v_rev from postings where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
    if v_rev is not null then return v_rev; end if;
    raise exception 'ALREADY_REVERSED' using errcode = 'P0001';
  end if;
  v_rev := reverse_posting(p_tenant, v_post, p_idempotency_key, p_by, p_session_level, p_device, btrim(p_reason));
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, p_session_level, p_kind || '.reverse', p_kind, p_id::text, 'success', btrim(p_reason), jsonb_build_object('no', v_no));
  return v_rev;
end $$;

-- Opening cash and bank (W-17 §4): once, A2 + re-auth. Dr CASH, BANK / Cr OPENING_EQUITY.
create or replace function post_finance_opening(
  p_tenant uuid, p_idempotency_key uuid, p_cash numeric, p_bank numeric, p_as_of date,
  p_by uuid, p_session_level text, p_reauth_at timestamptz, p_device uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_post uuid; v_replayed boolean; v_cash numeric := round(coalesce(p_cash, 0), 2); v_bank numeric := round(coalesce(p_bank, 0), 2); v_entries jsonb := '[]';
begin
  if p_session_level not in ('A2', 'A3') or p_reauth_at is null or p_reauth_at < now() - interval '5 minutes' then raise exception 'REAUTH_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_expenses') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if v_cash < 0 or v_bank < 0 or v_cash + v_bank <= 0 then raise exception 'BAD_AMOUNT' using errcode = 'P0001'; end if;
  if p_as_of is null or p_as_of > stock_today(p_tenant) then raise exception 'BAD_DATE' using errcode = 'P0001'; end if;
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'finance_opening', p_tenant, p_by, p_session_level, p_device) b;
  if v_replayed then return v_post; end if;
  if exists (select 1 from finance_openings where tenant_id = p_tenant) then raise exception 'OPENING_EXISTS' using errcode = 'P0001'; end if;
  insert into finance_openings (tenant_id, cash_amount, bank_amount, as_of, recorded_by, posting_id) values (p_tenant, v_cash, v_bank, p_as_of, p_by, v_post);
  if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'debit', v_cash, 'channel', 'cash', 'memo', 'opening'); end if;
  if v_bank > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'debit', v_bank, 'memo', 'opening'); end if;
  v_entries := v_entries || jsonb_build_object('account', 'OPENING_EQUITY', 'credit', v_cash + v_bank, 'memo', 'opening');
  perform post_journal(p_tenant, v_post, v_entries);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'finance.opening', 'tenant', p_tenant::text, 'success', jsonb_build_object('cash', v_cash, 'bank', v_bank, 'as_of', p_as_of));
  return v_post;
end $$;

-- ── reports ───────────────────────────────────────────────────────────────────
-- Finance report for business days [from, to] (W-17 §5): opening and closing balances, and
-- every flow, all summed from the journal. Opening(T) = Σ before T, so it can't drift.
create or replace function finance_report(p_tenant uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare r record; v_bal jsonb := '{}'; a text; v_flow jsonb; v_money jsonb; v_exp jsonb; v_chan jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_PERIOD' using errcode = 'P0001'; end if;
  select * into r from finance_range(p_tenant, p_from, p_to);
  foreach a in array array['CASH', 'BANK', 'AR_PATIENTS', 'INVENTORY', 'INVENTORY_IN_TRANSIT', 'VENDOR_ADVANCES', 'TAX_RECEIVABLE', 'AP_VENDORS', 'TAX_PAYABLE'] loop
    v_bal := v_bal || jsonb_build_object(a, jsonb_build_object(
      'opening', case when a in ('AP_VENDORS', 'TAX_PAYABLE') then -account_balance(p_tenant, a, r.t0) else account_balance(p_tenant, a, r.t0) end,
      'closing', case when a in ('AP_VENDORS', 'TAX_PAYABLE') then -account_balance(p_tenant, a, r.t1) else account_balance(p_tenant, a, r.t1) end));
  end loop;
  -- income/expense flows (credit − debit for income, debit − credit for expenses)
  select coalesce(jsonb_object_agg(code, amt), '{}') into v_flow from (
    select e.account_code code, sum(case when la.type = 'income' then e.credit - e.debit else e.debit - e.credit end) amt
      from ledger_entries e join ledger_accounts la on la.tenant_id = e.tenant_id and la.code = e.account_code
     where e.tenant_id = p_tenant and e.occurred_at >= r.t0 and e.occurred_at < r.t1 and la.type in ('income', 'expense')
     group by 1) f;
  select coalesce(jsonb_agg(jsonb_build_object('code', la.code, 'name', la.name, 'amount', coalesce((v_flow->>la.code)::numeric, 0)) order by la.name), '[]') into v_exp
    from ledger_accounts la where la.tenant_id = p_tenant and la.code like 'EXP\_%' and coalesce((v_flow->>la.code)::numeric, 0) <> 0;
  -- money in and out by what caused it (a reversal counts under what it reverses)
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'cash_in', cash_in, 'cash_out', cash_out, 'bank_in', bank_in, 'bank_out', bank_out) order by kind), '[]') into v_money from (
    select coalesce(o.doc_type, p.doc_type) kind,
           sum(case when e.account_code = 'CASH' then e.debit else 0 end) cash_in, sum(case when e.account_code = 'CASH' then e.credit else 0 end) cash_out,
           sum(case when e.account_code = 'BANK' then e.debit else 0 end) bank_in, sum(case when e.account_code = 'BANK' then e.credit else 0 end) bank_out
      from ledger_entries e join postings p on p.id = e.posting_id left join postings o on o.id = p.reverses_posting_id
     where e.tenant_id = p_tenant and e.account_code in ('CASH', 'BANK') and e.occurred_at >= r.t0 and e.occurred_at < r.t1
     group by 1) m;
  -- online money by channel (net)
  select coalesce(jsonb_object_agg(ch, amt), '{}') into v_chan from (
    select coalesce(channel, 'unspecified') ch, sum(debit - credit) amt from ledger_entries
     where tenant_id = p_tenant and account_code = 'BANK' and occurred_at >= r.t0 and occurred_at < r.t1 group by 1) c;
  return jsonb_build_object('from', p_from, 'to', p_to, 'balances', v_bal,
    'revenue_services', coalesce((v_flow->>'REV_SERVICES')::numeric, 0), 'revenue_pharmacy', coalesce((v_flow->>'REV_PHARMACY')::numeric, 0),
    'other_income', coalesce((v_flow->>'REV_OTHER')::numeric, 0), 'cogs', coalesce((v_flow->>'COGS')::numeric, 0),
    'inventory_loss', coalesce((v_flow->>'INV_LOSS')::numeric, 0), 'inventory_gain', coalesce((v_flow->>'INV_GAIN')::numeric, 0),
    'rounding', coalesce((v_flow->>'ROUNDING')::numeric, 0),
    'expenses', coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(v_exp) x), 0), 'expenses_by_category', v_exp,
    'money', v_money, 'online_by_channel', v_chan);
end $$;

-- Profit and loss for business days [from, to], tenant-wide or for one store (W-17 §6).
-- Store view: entries tagged with that store (expenses only if tagged).
create or replace function profit_and_loss(p_tenant uuid, p_store uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare r record; v jsonb; rs numeric; rp numeric; ro numeric; cg numeric; il numeric; ig numeric; ex numeric; rd numeric;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_PERIOD' using errcode = 'P0001'; end if;
  select * into r from finance_range(p_tenant, p_from, p_to);
  select coalesce(jsonb_object_agg(code, amt), '{}') into v from (
    select e.account_code code, sum(case when la.type = 'income' then e.credit - e.debit else e.debit - e.credit end) amt
      from ledger_entries e join ledger_accounts la on la.tenant_id = e.tenant_id and la.code = e.account_code
     where e.tenant_id = p_tenant and e.occurred_at >= r.t0 and e.occurred_at < r.t1 and la.type in ('income', 'expense')
       and (p_store is null or e.store_id = p_store)
     group by 1) f;
  rs := coalesce((v->>'REV_SERVICES')::numeric, 0); rp := coalesce((v->>'REV_PHARMACY')::numeric, 0); ro := coalesce((v->>'REV_OTHER')::numeric, 0);
  cg := coalesce((v->>'COGS')::numeric, 0); il := coalesce((v->>'INV_LOSS')::numeric, 0); ig := coalesce((v->>'INV_GAIN')::numeric, 0); rd := coalesce((v->>'ROUNDING')::numeric, 0);
  select coalesce(sum(value::numeric), 0) into ex from jsonb_each_text(v) where key like 'EXP\_%';
  return jsonb_build_object('from', p_from, 'to', p_to, 'store', p_store,
    'revenue_services', rs, 'revenue_pharmacy', rp, 'revenue', rs + rp, 'cogs', cg, 'gross_profit', rs + rp - cg,
    'inventory_loss', il, 'inventory_gain', ig, 'expenses', ex, 'rounding', rd, 'other_income', ro,
    'net_profit', rs + rp - cg - il + ig - ex - rd + ro);
end $$;

-- One business day at a glance (bills, collections, refunds, dues, expenses, cash at close).
create or replace function daily_summary(p_tenant uuid, p_day date)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare r record;
begin
  select * into r from finance_range(p_tenant, p_day, p_day);
  return jsonb_build_object('day', p_day,
    'bills', (select count(*) from invoices where tenant_id = p_tenant and issued_at >= r.t0 and issued_at < r.t1),
    'voided', (select count(*) from invoices where tenant_id = p_tenant and issued_at >= r.t0 and issued_at < r.t1 and status = 'void'),
    'sales', (select coalesce(sum(total), 0) from invoices where tenant_id = p_tenant and issued_at >= r.t0 and issued_at < r.t1 and status = 'issued'),
    'returns', (select coalesce(sum(total), 0) from sale_returns where tenant_id = p_tenant and created_at >= r.t0 and created_at < r.t1),
    'collected', (select coalesce(sum(amount), 0) from payments where tenant_id = p_tenant and received_at >= r.t0 and received_at < r.t1 and amount > 0),
    'refunded', (select coalesce(-sum(amount), 0) from payments where tenant_id = p_tenant and received_at >= r.t0 and received_at < r.t1 and amount < 0),
    'dues_change', account_balance(p_tenant, 'AR_PATIENTS', r.t1) - account_balance(p_tenant, 'AR_PATIENTS', r.t0),
    'expenses', (select coalesce(sum(amount), 0) from expenses e where tenant_id = p_tenant and recorded_at >= r.t0 and recorded_at < r.t1 and not posting_reversed(e.posting_id)),
    'cash_close', account_balance(p_tenant, 'CASH', r.t1), 'bank_close', account_balance(p_tenant, 'BANK', r.t1));
end $$;

-- =============================================================================
-- Finance integrity (database.md §12): recompute from the documents and compare with the
-- journal. A difference is logged (audit outcome error) and shown; nothing is repaired.
-- Inventory allows Rs. 1 of rounding (bill lines round cost to the paisa; the ledger doesn't).
-- =============================================================================
create or replace function verify_finance_integrity(p_tenant uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_checks jsonb := '[]'; v_bad integer := 0; d numeric; j numeric; v_tol numeric;
        v_name text;
begin
  for v_name in select unnest(array['receivables', 'inventory', 'cash', 'bank']) loop
    v_tol := 0.01;
    if v_name = 'receivables' then
      select coalesce(sum(invoice_outstanding(id)), 0) into d from invoices where tenant_id = p_tenant and status = 'issued';
      j := account_balance(p_tenant, 'AR_PATIENTS', 'infinity');
    elsif v_name = 'inventory' then
      select coalesce(sum(qty_base * unit_cost_base), 0) into d from stock_movements where tenant_id = p_tenant;
      j := account_balance(p_tenant, 'INVENTORY', 'infinity');
      v_tol := 1.00;
    else
      select coalesce(sum(case when v_name = 'cash' then cash_amount else online_amount end), 0) into d from payments where tenant_id = p_tenant;
      d := d + coalesce((select sum(case when v_name = 'cash' then cash_amount else online_amount end) from other_income i where tenant_id = p_tenant and not posting_reversed(i.posting_id)), 0)
             - coalesce((select sum(case when v_name = 'cash' then cash_amount else online_amount end) from expenses e where tenant_id = p_tenant and not posting_reversed(e.posting_id)), 0)
             - coalesce((select sum(case when v_name = 'cash' then cash_amount else online_amount end) from vendor_payments where tenant_id = p_tenant), 0)
             - coalesce((select sum(case when v_name = 'cash' then paid_cash else paid_online end) from purchase_invoices where tenant_id = p_tenant and status = 'posted'), 0)
             + coalesce((select sum(total) from purchase_returns where tenant_id = p_tenant and settlement = case when v_name = 'cash' then 'cash_refund' else 'online_refund' end), 0)
             + coalesce((select case when v_name = 'cash' then cash_amount else bank_amount end from finance_openings where tenant_id = p_tenant), 0);
      j := account_balance(p_tenant, upper(v_name), 'infinity');
    end if;
    v_checks := v_checks || jsonb_build_object('check', v_name, 'documents', round(d, 2), 'journal', round(j, 2), 'ok', abs(d - j) <= v_tol);
    if abs(d - j) > v_tol then v_bad := v_bad + 1; end if;
  end loop;
  insert into finance_checks (tenant_id, mismatches, checks) values (p_tenant, v_bad, v_checks);
  if v_bad > 0 then
    insert into audit_log (tenant_id, actor_kind, action, outcome, detail)
    values (p_tenant, 'system', 'finance.integrity', 'error', jsonb_build_object('mismatches', v_bad, 'checks', v_checks));
  end if;
  return jsonb_build_object('mismatches', v_bad, 'checks', v_checks);
end $$;

-- The nightly job now also runs the finance integrity check.
create or replace function reconcile_all_tenants()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare t uuid; r jsonb; p jsonb; f jsonb; v_out jsonb := '[]'; v_total integer := 0; v_pay integer := 0; v_fin integer := 0;
begin
  for t in select id from tenants where status in ('active', 'pending') loop
    r := reconcile_stock_balances(t, null);
    p := reconcile_vendor_payables(t);
    f := verify_finance_integrity(t);
    v_total := v_total + (r->>'mismatches')::integer;
    v_pay := v_pay + (p->>'mismatches')::integer;
    v_fin := v_fin + (f->>'mismatches')::integer;
    if (r->>'mismatches')::integer > 0 or (p->>'mismatches')::integer > 0 or (f->>'mismatches')::integer > 0 then
      v_out := v_out || jsonb_build_object('tenant', t, 'mismatches', r->'mismatches', 'payable_mismatches', p->'mismatches', 'finance_mismatches', f->'mismatches');
    end if;
  end loop;
  return jsonb_build_object('mismatches', v_total, 'payable_mismatches', v_pay, 'finance_mismatches', v_fin, 'tenants', v_out);
end $$;

-- ── ownership and privileges ──────────────────────────────────────────────────
grant select on expenses, other_income, finance_openings, finance_checks, ledger_accounts, vendor_payments, purchase_invoices, purchase_returns,
                payments, invoices, stock_movements, postings to ledger_writer;
grant insert on expenses, other_income, finance_openings, finance_checks to ledger_writer;
grant usage, select on sequence finance_checks_id_seq to ledger_writer;
grant execute on function finance_range(uuid, date, date), account_balance(uuid, text, timestamptz), posting_reversed(uuid), doc_number(uuid, text, text),
                          invoice_outstanding(uuid), stock_today(uuid) to ledger_writer;
grant create on schema public to ledger_writer;
alter function record_expense(uuid, uuid, text, numeric, numeric, text, uuid, text, uuid, text, uuid) owner to ledger_writer;
alter function record_other_income(uuid, uuid, text, numeric, numeric, text, uuid, text, uuid) owner to ledger_writer;
alter function reverse_finance_entry(uuid, uuid, text, uuid, text, uuid, text, timestamptz, uuid) owner to ledger_writer;
alter function post_finance_opening(uuid, uuid, numeric, numeric, date, uuid, text, timestamptz, uuid) owner to ledger_writer;
alter function verify_finance_integrity(uuid) owner to ledger_writer;
alter function reconcile_all_tenants() owner to ledger_writer;
revoke create on schema public from ledger_writer;

revoke all on function record_expense(uuid, uuid, text, numeric, numeric, text, uuid, text, uuid, text, uuid),
                       record_other_income(uuid, uuid, text, numeric, numeric, text, uuid, text, uuid),
                       reverse_finance_entry(uuid, uuid, text, uuid, text, uuid, text, timestamptz, uuid),
                       post_finance_opening(uuid, uuid, numeric, numeric, date, uuid, text, timestamptz, uuid),
                       verify_finance_integrity(uuid), reconcile_all_tenants(),
                       finance_range(uuid, date, date), account_balance(uuid, text, timestamptz), posting_reversed(uuid),
                       finance_report(uuid, date, date), profit_and_loss(uuid, uuid, date, date), daily_summary(uuid, date)
  from public, anon, authenticated;
grant execute on function record_expense(uuid, uuid, text, numeric, numeric, text, uuid, text, uuid, text, uuid),
                          record_other_income(uuid, uuid, text, numeric, numeric, text, uuid, text, uuid),
                          reverse_finance_entry(uuid, uuid, text, uuid, text, uuid, text, timestamptz, uuid),
                          post_finance_opening(uuid, uuid, numeric, numeric, date, uuid, text, timestamptz, uuid),
                          verify_finance_integrity(uuid), reconcile_all_tenants(),
                          finance_range(uuid, date, date), account_balance(uuid, text, timestamptz), posting_reversed(uuid),
                          finance_report(uuid, date, date), profit_and_loss(uuid, uuid, date, date), daily_summary(uuid, date)
  to service_role;
