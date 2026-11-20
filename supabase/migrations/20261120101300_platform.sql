-- =============================================================================
-- 0014 PLATFORM (B2): plans, subscriptions, platform billing, applications,
-- provisioning, invites, first stores.
-- database.md §3; workflows W-01, W-33; decisions D-29, D-36, D-50, D-58.
-- Email is deferred (D-64): applications are reviewed by the platform admin instead of
-- email-verified, and the tenant admin invite is a one-time LINK the platform admin shares.
-- =============================================================================

alter table tenants add column status_reason text;
comment on column tenants.status_reason is 'Why the tenant is in its status, e.g. subscription_expired (auto-suspension) or a platform admin''s note.';

-- ── plans ─────────────────────────────────────────────────────────────────────
create table plans (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique check (code ~ '^[a-z0-9-]{2,40}$'),
  name                text not null check (length(btrim(name)) between 2 and 60),
  description         text,
  price_npr           numeric(12,2) not null check (price_npr >= 0),
  billing_cycle_days  smallint not null default 365 check (billing_cycle_days between 1 and 1100),
  max_doctors         smallint check (max_doctors > 0),
  max_members         smallint check (max_members > 0),
  max_stores          smallint check (max_stores > 0),
  features            text[] not null default '{}',
  is_public           boolean not null default false,
  is_active           boolean not null default true,
  sort_order          smallint not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table plans is 'Subscription plans. Public ones are listed on the marketing pricing page. features (e.g. lab) switch on plan-gated modules (lib/modules.ts).';
create trigger plans_touch before update on plans for each row execute function touch_updated_at();

-- ── subscriptions (append-only periods; the current state is derived) ─────────
create table tenant_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete restrict,
  plan_id     uuid not null references plans (id),
  starts_on   date not null,
  ends_on     date not null,
  source      text not null check (source in ('trial', 'paid', 'extension', 'complimentary')),
  price_npr   numeric(12,2) not null default 0 check (price_npr >= 0),
  note        text,
  created_by  uuid references platform_admins (id),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  check (ends_on >= starts_on)
);
create index tenant_subscriptions_tenant on tenant_subscriptions (tenant_id, ends_on desc);
comment on table tenant_subscriptions is 'Subscription periods, append-only. "Paid until" = the latest ends_on of periods that have started. Nothing stores the current status (HRestroSewa: computed everywhere, stored nowhere).';
create trigger tenant_subscriptions_no_update before update or delete on tenant_subscriptions for each row execute function forbid_mutation();

-- ── platform billing ──────────────────────────────────────────────────────────
create table platform_sequences (
  doc_type     text not null,
  fiscal_year  text not null references fiscal_years (code),
  next_no      bigint not null check (next_no >= 1),
  primary key (doc_type, fiscal_year)
);

create table platform_invoices (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants (id) on delete restrict,
  invoice_no       text not null unique,
  fiscal_year      text not null references fiscal_years (code),
  subscription_id  uuid,
  description      text not null,
  amount_npr       numeric(12,2) not null check (amount_npr > 0),
  issued_at        timestamptz not null default now(),
  due_on           date,
  status           text not null default 'issued' check (status in ('issued', 'void')),
  void_reason      text,
  issued_by        uuid references platform_admins (id),
  unique (tenant_id, id),
  foreign key (tenant_id, subscription_id) references tenant_subscriptions (tenant_id, id),
  check ((status = 'void') = (void_reason is not null))
);
comment on table platform_invoices is 'What the platform bills a clinic. Paid amount and balance are derived from platform_payments.';

create table platform_payments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  invoice_id   uuid not null,
  amount_npr   numeric(12,2) not null check (amount_npr > 0),
  method       text not null check (method in ('cash', 'bank_transfer', 'esewa', 'khalti', 'fonepay', 'cheque', 'other')),
  reference    text,
  received_on  date not null,
  recorded_by  uuid references platform_admins (id),
  created_at   timestamptz not null default now(),
  foreign key (tenant_id, invoice_id) references platform_invoices (tenant_id, id)
);
create trigger platform_payments_no_update before update or delete on platform_payments for each row execute function forbid_mutation();

-- ── registration applications (marketing site) ────────────────────────────────
create table tenant_applications (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid references tenants (id),
  business_name   text not null check (length(btrim(business_name)) between 2 and 120),
  business_type   business_type not null default 'clinic_pharmacy',
  owner_name      text not null check (length(btrim(owner_name)) between 2 and 80),
  email           text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone           text not null check (phone ~ '^[0-9+ -]{7,20}$'),
  district        text,
  municipality    text,
  pan_number      text,
  plan_interest   uuid references plans (id),
  message         text check (length(message) <= 1000),
  status          text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  reviewed_by     uuid references platform_admins (id),
  reviewed_at     timestamptz,
  reject_reason   text,
  ip              inet,
  user_agent      text,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  check ((status = 'rejected') = (reject_reason is not null)),
  check ((status = 'approved') = (tenant_id is not null))
);
create index tenant_applications_status on tenant_applications (status, created_at desc);
create index tenant_applications_ip_time on tenant_applications (ip, created_at desc);
create unique index tenant_applications_one_open_per_email on tenant_applications (lower(email)) where status = 'submitted';
comment on table tenant_applications is 'Registration requests from the marketing site (W-01). Not a tenant. A platform admin approves (→ provision_tenant) or rejects with a reason.';

-- ── invites (one-time link; email delivery comes later) ───────────────────────
create table member_invites (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  member_id         uuid not null,
  token_hash        text not null unique,
  expires_at        timestamptz not null default now() + interval '7 days',
  used_at           timestamptz,
  revoked_at        timestamptz,
  created_by_admin  uuid references platform_admins (id),
  created_by_member uuid,
  created_at        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id) on delete cascade,
  foreign key (tenant_id, created_by_member) references tenant_members (tenant_id, id)
);
comment on table member_invites is 'One-time invite links (only the HMAC of the token is stored). The person opens the link, sets a password, and their auth account is created and linked.';

-- ── stores (first slice; B5 adds lots, balances, members, transfers) ──────────
create table stores (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete restrict,
  code                text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  name                text not null check (length(btrim(name)) between 2 and 60),
  kind                text not null check (kind in ('main', 'pharmacy', 'emergency', 'department', 'branch', 'quarantine')),
  billing_profile_id  uuid,
  is_sellable         boolean not null default false,
  is_dispensing       boolean not null default false,
  is_receiving        boolean not null default false,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  foreign key (tenant_id, billing_profile_id) references billing_profiles (tenant_id, id),
  check (kind <> 'quarantine' or not is_sellable)
);
create unique index stores_one_quarantine on stores (tenant_id) where kind = 'quarantine';

-- ── access ────────────────────────────────────────────────────────────────────
alter table plans                enable row level security;
alter table tenant_subscriptions enable row level security;
alter table platform_sequences   enable row level security;
alter table platform_invoices    enable row level security;
alter table platform_payments    enable row level security;
alter table tenant_applications  enable row level security;
alter table member_invites       enable row level security;
alter table stores               enable row level security;

-- Money and lifecycle tables change only through the functions below.
revoke insert, update, delete on tenant_subscriptions, platform_sequences, platform_invoices, platform_payments from service_role;
revoke update, delete on tenant_applications from service_role;
revoke all on member_invites from service_role;
revoke delete on plans, stores from service_role;

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- "Paid until": the latest end of a period that has started (Kathmandu calendar).
create or replace function tenant_paid_until(p_tenant uuid)
returns date
language sql stable
set search_path = pg_catalog, public
as $$
  select max(ends_on) from tenant_subscriptions
   where tenant_id = p_tenant and starts_on <= (now() at time zone 'Asia/Kathmandu')::date;
$$;

-- The plan features a tenant holds today (from its current period's plan).
create or replace function tenant_plan_features(p_tenant uuid)
returns text[]
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce((
    select p.features from tenant_subscriptions s join plans p on p.id = s.plan_id
     where s.tenant_id = p_tenant
       and (now() at time zone 'Asia/Kathmandu')::date between s.starts_on and s.ends_on
     order by s.ends_on desc, s.created_at desc limit 1), '{}');
$$;

-- effective_modules now honours plan features (lab etc.). Mirror of lib/modules.ts.
create or replace function effective_modules(p_tenant uuid)
returns text[]
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  v_bt text; v_set text[]; v_changed boolean := true; v_key text; v_req text[]; v_feat text[];
begin
  select business_type::text into v_bt from tenants where id = p_tenant;
  if v_bt is null then return '{}'; end if;
  v_feat := tenant_plan_features(p_tenant);
  select coalesce(array_agg(m.key order by m.key), '{}') into v_set
    from module_catalog m
    left join tenant_modules t on t.tenant_id = p_tenant and t.module_key = m.key
   where v_bt = any (m.business_types)
     and (m.plan_feature is null or m.plan_feature = any (v_feat))
     and coalesce(t.enabled, v_bt = any (coalesce(m.default_on_types, '{}')));
  while v_changed loop
    v_changed := false;
    foreach v_key in array v_set loop
      select requires into v_req from module_catalog where key = v_key;
      if v_req is not null and not (v_req <@ v_set) then
        v_set := array_remove(v_set, v_key);
        v_changed := true;
      end if;
    end loop;
  end loop;
  return v_set;
end $$;

-- Add a subscription period. Re-activates a tenant that was suspended ONLY for expiry.
create or replace function add_subscription_period(
  p_tenant uuid, p_plan uuid, p_starts_on date, p_ends_on date, p_source text, p_price numeric, p_note text, p_by uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid;
begin
  if not exists (select 1 from plans where id = p_plan and is_active) then raise exception 'PLAN_NOT_FOUND' using errcode = 'P0001'; end if;
  insert into tenant_subscriptions (tenant_id, plan_id, starts_on, ends_on, source, price_npr, note, created_by)
  values (p_tenant, p_plan, p_starts_on, p_ends_on, p_source, coalesce(p_price, 0), p_note, p_by)
  returning id into v_id;
  update tenants set status = 'active', status_reason = null
   where id = p_tenant and status = 'suspended' and status_reason = 'subscription_expired'
     and tenant_paid_until(p_tenant) >= (now() at time zone 'Asia/Kathmandu')::date;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'platform_admin', p_by, 'subscription.add', 'tenant_subscription', v_id::text, 'success',
          jsonb_build_object('starts_on', p_starts_on, 'ends_on', p_ends_on, 'source', p_source));
  return v_id;
end $$;

-- Daily job (W-33): suspend ACTIVE tenants whose paid-until date has passed. Never deletes
-- anything and never touches pending/closed tenants. Returns the number suspended.
create or replace function suspend_expired_tenants()
returns integer
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_n integer;
begin
  with expired as (
    update tenants t set status = 'suspended', status_reason = 'subscription_expired'
     where t.status = 'active'
       and coalesce(tenant_paid_until(t.id), date '1900-01-01') < (now() at time zone 'Asia/Kathmandu')::date
    returning t.id
  ), logged as (
    insert into audit_log (tenant_id, actor_kind, action, target_type, target_id, outcome, reason)
    select id, 'system', 'tenant.suspend', 'tenant', id::text, 'success', 'subscription_expired' from expired
    returning 1
  ) select count(*) into v_n from logged;
  return v_n;
end $$;

-- Lifecycle changes by a platform admin (activate / suspend / close), always with a reason.
create or replace function set_tenant_status(p_tenant uuid, p_status tenant_status, p_reason text, p_by uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_old tenant_status;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select status into v_old from tenants where id = p_tenant for update;
  if v_old is null then raise exception 'TENANT_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_old = 'closed' then raise exception 'TENANT_CLOSED' using errcode = 'P0001'; end if;
  update tenants set status = p_status, status_reason = btrim(p_reason) where id = p_tenant;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, reason, detail)
  values (p_tenant, 'platform_admin', p_by, 'tenant.status', 'tenant', p_tenant::text, 'success', btrim(p_reason),
          jsonb_build_object('from', v_old, 'to', p_status));
end $$;

-- Platform invoice numbers: gapless per platform fiscal year (CMS-2082/83-0001).
create or replace function issue_platform_invoice(
  p_tenant uuid, p_subscription uuid, p_description text, p_amount numeric, p_due_on date, p_by uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare v_fy text; v_no bigint; v_id uuid;
begin
  v_fy := fiscal_year_of(now(), 'Asia/Kathmandu');
  insert into platform_sequences as s (doc_type, fiscal_year, next_no) values ('invoice', v_fy, 2)
  on conflict on constraint platform_sequences_pkey do update set next_no = s.next_no + 1
  returning s.next_no - 1 into v_no;
  insert into platform_invoices (tenant_id, invoice_no, fiscal_year, subscription_id, description, amount_npr, due_on, issued_by)
  values (p_tenant, format('CMS-%s-%s', v_fy, lpad(v_no::text, 4, '0')), v_fy, p_subscription, btrim(p_description), p_amount, p_due_on, p_by)
  returning id into v_id;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'platform_admin', p_by, 'platform_invoice.issue', 'platform_invoice', v_id::text, 'success', jsonb_build_object('amount', p_amount));
  return v_id;
end $$;

create or replace function record_platform_payment(
  p_invoice uuid, p_amount numeric, p_method text, p_reference text, p_received_on date, p_by uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_inv platform_invoices; v_paid numeric; v_id uuid;
begin
  select * into v_inv from platform_invoices where id = p_invoice for update;
  if v_inv.id is null then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_inv.status = 'void' then raise exception 'INVOICE_VOID' using errcode = 'P0001'; end if;
  select coalesce(sum(amount_npr), 0) into v_paid from platform_payments where invoice_id = p_invoice;
  if v_paid + p_amount > v_inv.amount_npr then raise exception 'OVERPAYMENT' using errcode = 'P0001'; end if;
  insert into platform_payments (tenant_id, invoice_id, amount_npr, method, reference, received_on, recorded_by)
  values (v_inv.tenant_id, p_invoice, p_amount, p_method, nullif(btrim(p_reference), ''), p_received_on, p_by)
  returning id into v_id;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (v_inv.tenant_id, 'platform_admin', p_by, 'platform_payment.record', 'platform_invoice', p_invoice::text, 'success',
          jsonb_build_object('amount', p_amount, 'method', p_method));
  return v_id;
end $$;

-- Application intake from the public form (rate limit + duplicate check inside).
create or replace function submit_tenant_application(
  p_business_name text, p_owner_name text, p_email text, p_phone text, p_district text, p_municipality text,
  p_pan text, p_plan uuid, p_message text, p_ip inet, p_user_agent text
) returns text
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if p_ip is not null and (select count(*) from tenant_applications where ip = p_ip and created_at > now() - interval '24 hours') >= 5 then
    return 'RATE_LIMITED';
  end if;
  if exists (select 1 from tenant_applications where lower(email) = lower(btrim(p_email)) and status = 'submitted') then
    return 'ALREADY_SUBMITTED';
  end if;
  insert into tenant_applications (business_name, owner_name, email, phone, district, municipality, pan_number, plan_interest, message, ip, user_agent)
  values (btrim(p_business_name), btrim(p_owner_name), lower(btrim(p_email)), btrim(p_phone), nullif(btrim(p_district), ''),
          nullif(btrim(p_municipality), ''), nullif(btrim(p_pan), ''),
          (select id from plans where id = p_plan and is_public and is_active), nullif(btrim(p_message), ''), p_ip, left(p_user_agent, 300));
  return 'OK';
end $$;

create or replace function reject_tenant_application(p_application uuid, p_reason text, p_by uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  update tenant_applications set status = 'rejected', reject_reason = btrim(p_reason), reviewed_by = p_by, reviewed_at = now()
   where id = p_application and status = 'submitted';
  if not found then raise exception 'APPLICATION_NOT_OPEN' using errcode = 'P0001'; end if;
  insert into audit_log (actor_kind, actor_id, action, target_type, target_id, outcome, reason)
  values ('platform_admin', p_by, 'application.reject', 'tenant_application', p_application::text, 'success', btrim(p_reason));
end $$;

-- W-01 §4: approve + provision in ONE transaction. Everything a new clinic needs to start
-- setup: tenant (pending), settings, billing profile, role templates, Pharmacy + quarantine
-- stores, first subscription period, the tenant admin member and a one-time invite.
create or replace function provision_tenant(
  p_application uuid, p_slug text, p_plan uuid, p_starts_on date, p_period_days integer, p_source text,
  p_invite_token_hash text, p_by uuid
) returns table (tenant_id uuid, member_id uuid)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_variable
declare
  v_app tenant_applications; v_tenant uuid; v_bp uuid; v_member uuid; v_plan plans;
begin
  select * into v_app from tenant_applications where id = p_application for update;
  if v_app.id is null or v_app.status <> 'submitted' then raise exception 'APPLICATION_NOT_OPEN' using errcode = 'P0001'; end if;
  select * into v_plan from plans where id = p_plan and is_active;
  if v_plan.id is null then raise exception 'PLAN_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from tenants where slug = p_slug) then raise exception 'SLUG_TAKEN' using errcode = 'P0001'; end if;

  insert into tenants (slug, name, legal_name, business_type, pan_number, phone, email, address_district, address_municipality, status)
  values (p_slug, v_app.business_name, v_app.business_name, v_app.business_type, v_app.pan_number, v_app.phone, v_app.email,
          v_app.district, v_app.municipality, 'pending')
  returning id into v_tenant;

  insert into billing_profiles (tenant_id, name, legal_name, pan_vat_no, phone, invoice_prefix, is_default)
  values (v_tenant, 'Clinic', v_app.business_name, v_app.pan_number, v_app.phone, '', true)
  returning id into v_bp;
  insert into tenant_settings (tenant_id, default_billing_profile_id) values (v_tenant, v_bp);
  perform seed_role_templates(v_tenant);
  insert into stores (tenant_id, code, name, kind, billing_profile_id, is_sellable, is_dispensing, is_receiving)
  values (v_tenant, 'PHARM', 'Pharmacy', 'pharmacy', v_bp, true, true, true),
         (v_tenant, 'QUAR', 'Quarantine', 'quarantine', v_bp, false, false, false);

  insert into tenant_subscriptions (tenant_id, plan_id, starts_on, ends_on, source, price_npr, created_by)
  values (v_tenant, p_plan, p_starts_on, p_starts_on + (p_period_days - 1), p_source,
          case when p_source = 'paid' then v_plan.price_npr else 0 end, p_by);

  insert into tenant_members (tenant_id, membership_role, display_name, email, phone, title)
  values (v_tenant, 'tenant_admin', v_app.owner_name, v_app.email, v_app.phone, 'Clinic admin')
  returning id into v_member;
  insert into member_invites (tenant_id, member_id, token_hash, created_by_admin) values (v_tenant, v_member, p_invite_token_hash, p_by);

  update tenant_applications set status = 'approved', tenant_id = v_tenant, reviewed_by = p_by, reviewed_at = now() where id = p_application;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (v_tenant, 'platform_admin', p_by, 'tenant.provision', 'tenant', v_tenant::text, 'success',
          jsonb_build_object('application', p_application, 'slug', p_slug, 'plan', v_plan.code, 'source', p_source));
  return query select v_tenant, v_member;
end $$;

-- New invite link for a member who has not accepted yet (older links stop working).
create or replace function reissue_invite(p_tenant uuid, p_member uuid, p_token_hash text, p_by_admin uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from tenant_members where id = p_member and tenant_id = p_tenant and auth_user_id is null and is_active) then
    raise exception 'MEMBER_NOT_INVITABLE' using errcode = 'P0001';
  end if;
  update member_invites set revoked_at = now() where member_id = p_member and used_at is null and revoked_at is null;
  insert into member_invites (tenant_id, member_id, token_hash, created_by_admin) values (p_tenant, p_member, p_token_hash, p_by_admin);
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome)
  values (p_tenant, 'platform_admin', p_by_admin, 'member.invite_reissue', 'tenant_member', p_member::text, 'success');
end $$;

-- What an invite link may show BEFORE acceptance (no secrets, nothing else about the tenant).
create or replace function invite_preview(p_token_hash text)
returns table (invite_id uuid, tenant_name text, tenant_slug text, member_name text, email text, username text)
language sql security definer stable
set search_path = pg_catalog, public
as $$
  select i.id, t.name, t.slug, m.display_name, m.email, m.username
    from member_invites i join tenant_members m on m.id = i.member_id join tenants t on t.id = i.tenant_id
   where i.token_hash = p_token_hash and i.used_at is null and i.revoked_at is null and i.expires_at > now()
     and m.auth_user_id is null and m.is_active and t.status <> 'closed';
$$;

-- Link the newly created auth account to the invited member, once.
create or replace function accept_invite(p_token_hash text, p_auth_user uuid)
returns table (tenant_id uuid, member_id uuid)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_variable
declare v_inv member_invites;
begin
  select * into v_inv from member_invites
   where token_hash = p_token_hash and used_at is null and revoked_at is null and expires_at > now() for update;
  if v_inv.id is null then raise exception 'INVITE_INVALID' using errcode = 'P0001'; end if;
  update tenant_members set auth_user_id = p_auth_user where id = v_inv.member_id and auth_user_id is null;
  if not found then raise exception 'INVITE_INVALID' using errcode = 'P0001'; end if;
  update member_invites set used_at = now() where id = v_inv.id;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome)
  values (v_inv.tenant_id, 'member', v_inv.member_id, 'member.invite_accept', 'tenant_member', v_inv.member_id::text, 'success');
  return query select v_inv.tenant_id, v_inv.member_id;
end $$;

-- ── privileges ───────────────────────────────────────────────────────────────
revoke all on function tenant_paid_until(uuid)                                                     from public, anon, authenticated;
revoke all on function tenant_plan_features(uuid)                                                  from public, anon, authenticated;
revoke all on function add_subscription_period(uuid, uuid, date, date, text, numeric, text, uuid) from public, anon, authenticated;
revoke all on function suspend_expired_tenants()                                                   from public, anon, authenticated;
revoke all on function set_tenant_status(uuid, tenant_status, text, uuid)                          from public, anon, authenticated;
revoke all on function issue_platform_invoice(uuid, uuid, text, numeric, date, uuid)              from public, anon, authenticated;
revoke all on function record_platform_payment(uuid, numeric, text, text, date, uuid)             from public, anon, authenticated;
revoke all on function submit_tenant_application(text, text, text, text, text, text, text, uuid, text, inet, text) from public, anon, authenticated;
revoke all on function reject_tenant_application(uuid, text, uuid)                                 from public, anon, authenticated;
revoke all on function provision_tenant(uuid, text, uuid, date, integer, text, text, uuid)        from public, anon, authenticated;
revoke all on function reissue_invite(uuid, uuid, text, uuid)                                      from public, anon, authenticated;
revoke all on function invite_preview(text)                                                        from public, anon, authenticated;
revoke all on function accept_invite(text, uuid)                                                   from public, anon, authenticated;

grant execute on function tenant_paid_until(uuid)                                                     to service_role;
grant execute on function tenant_plan_features(uuid)                                                  to service_role;
grant execute on function add_subscription_period(uuid, uuid, date, date, text, numeric, text, uuid) to service_role;
grant execute on function suspend_expired_tenants()                                                   to service_role;
grant execute on function set_tenant_status(uuid, tenant_status, text, uuid)                          to service_role;
grant execute on function issue_platform_invoice(uuid, uuid, text, numeric, date, uuid)              to service_role;
grant execute on function record_platform_payment(uuid, numeric, text, text, date, uuid)             to service_role;
grant execute on function submit_tenant_application(text, text, text, text, text, text, text, uuid, text, inet, text) to service_role;
grant execute on function reject_tenant_application(uuid, text, uuid)                                 to service_role;
grant execute on function provision_tenant(uuid, text, uuid, date, integer, text, text, uuid)        to service_role;
grant execute on function reissue_invite(uuid, uuid, text, uuid)                                      to service_role;
grant execute on function invite_preview(text)                                                        to service_role;
grant execute on function accept_invite(text, uuid)                                                   to service_role;
