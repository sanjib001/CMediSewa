-- =============================================================================
-- 0003 TENANCY CORE: tenants, billing profiles, settings, modules, audit log
-- database.md §3, §5, §13; decisions D-03, D-26, D-49, D-50, D-58, D-23.
--
-- Conventions every later migration follows:
--   * every tenant-owned table has tenant_id and `unique (tenant_id, id)`;
--   * every reference to a tenant-owned row is a COMPOSITE FK (tenant_id, x_id), so a
--     row of tenant A can never point at a row of tenant B, even if application code
--     has a bug (the structural upgrade over HRestroSewa, D-03);
--   * RLS enabled on every table (deny-all backstop, D-04);
--   * `comment on` explains WHY.
-- =============================================================================

create type tenant_status as enum ('pending', 'active', 'suspended', 'closed');
create type business_type as enum ('clinic', 'clinic_pharmacy', 'pharmacy');

-- ── tenants ───────────────────────────────────────────────────────────────────
create table tenants (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique
                        check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$'),
  name                  text not null check (length(btrim(name)) between 2 and 120),
  legal_name            text,
  business_type         business_type not null default 'clinic_pharmacy',
  pan_number            text,
  registration_no       text,
  phone                 text,
  email                 text,
  address_province      text,
  address_district      text,
  address_municipality  text,
  address_ward          text,
  address_street        text,
  logo_path             text,
  timezone              text not null default 'Asia/Kathmandu',
  status                tenant_status not null default 'pending',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table tenants is
  'One registered medical business (D-26). The root of every tenant-owned row. Launch type is clinic_pharmacy (D-58).';
comment on column tenants.slug is
  'Public path segment (/c/<slug>, /login/<slug>). Selects branding only; never authorises anything (architecture.md §6).';
comment on column tenants.status is
  'pending → active (go-live) → suspended (expiry: read-only admin, no booking) → closed. Checked live on every request.';
create trigger tenants_touch before update on tenants for each row execute function touch_updated_at();

-- ── billing_profiles (D-49) ───────────────────────────────────────────────────
create table billing_profiles (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants (id) on delete restrict,
  name             text not null check (length(btrim(name)) between 1 and 60),
  legal_name       text not null,
  pan_vat_no       text,
  registration_no  text,
  address          text,
  phone            text,
  invoice_prefix   text not null default '' check (invoice_prefix ~ '^[A-Za-z0-9-]{0,12}$'),
  invoice_pad      smallint not null default 5 check (invoice_pad between 1 and 10),
  receipt_footer   text,
  is_default       boolean not null default false,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index billing_profiles_one_default on billing_profiles (tenant_id) where is_default;
create unique index billing_profiles_name_unique on billing_profiles (tenant_id, lower(btrim(name)));
comment on table billing_profiles is
  'The legal entity an invoice is issued by: legal name, PAN, number series. One per tenant at launch (same PAN for clinic and pharmacy, D-58); a second is possible without schema change (D-49).';
create trigger billing_profiles_touch before update on billing_profiles for each row execute function touch_updated_at();

-- ── tenant_settings (1:1) ─────────────────────────────────────────────────────
-- Typed columns, not jsonb: booking, billing and stock rules are read by SQL inside RPCs
-- and need constraints (architecture.md §8). Store-related defaults are added with the
-- stores table in B5.
create table tenant_settings (
  tenant_id                             uuid primary key references tenants (id) on delete restrict,
  -- booking
  booking_window_days                   smallint not null default 30  check (booking_window_days between 1 and 365),
  min_notice_minutes                    smallint not null default 60  check (min_notice_minutes between 0 and 10080),
  cancellation_cutoff_hours             smallint not null default 2   check (cancellation_cutoff_hours between 0 and 168),
  auto_confirm_online                   boolean  not null default true,
  scheduling_mode                       text     not null default 'both' check (scheduling_mode in ('slot', 'token', 'both')),
  max_active_online_bookings_per_phone  smallint not null default 2   check (max_active_online_bookings_per_phone between 1 and 20),
  -- billing
  consultation_billing_point            text     not null default 'check_in' check (consultation_billing_point in ('check_in', 'checkout', 'none')),
  default_billing_profile_id            uuid,
  print_paper_width                     text     not null default '80mm' check (print_paper_width in ('58mm', '80mm', 'a5', 'a4')),
  max_discount_pct_without_reauth       numeric(5,2) not null default 10 check (max_discount_pct_without_reauth between 0 and 100),
  allow_credit                          boolean  not null default false,
  credit_limit_per_patient              numeric(12,2) not null default 0 check (credit_limit_per_patient >= 0),
  -- operations
  day_closing_hour                      smallint not null default 0  check (day_closing_hour between 0 and 23),
  pin_policy                            text     not null default 'allowed' check (pin_policy in ('off', 'allowed', 'required')),
  idle_lock_minutes                     smallint not null default 10 check (idle_lock_minutes between 1 and 240),
  shift_window_hours                    smallint not null default 12 check (shift_window_hours between 1 and 24),
  -- privacy
  push_shows_patient_name               boolean  not null default false,
  -- inventory (stock-store defaults arrive with stores in B5)
  near_expiry_days                      smallint not null default 90 check (near_expiry_days between 1 and 730),
  critical_expiry_days                  smallint not null default 30 check (critical_expiry_days between 0 and 365),
  min_sale_shelf_days                   smallint not null default 0  check (min_sale_shelf_days between 0 and 365),
  min_receive_shelf_days                smallint not null default 90 check (min_receive_shelf_days between 0 and 1095),
  allocation_policy                     text     not null default 'fefo' check (allocation_policy in ('fefo', 'fifo')),
  transfer_approval_required            boolean  not null default false,
  count_post_requires_other_member      boolean  not null default false,
  allow_price_above_mrp                 boolean  not null default false,
  updated_at                            timestamptz not null default now(),
  check (critical_expiry_days <= near_expiry_days),
  foreign key (tenant_id, default_billing_profile_id) references billing_profiles (tenant_id, id)
);
comment on table tenant_settings is
  'Per-tenant operating rules, one row per tenant. Defaults follow the owner decisions (OPD fee at check-in, D-58; FEFO, D-40). Negative stock is not a setting: the DB forbids it (D-38).';
create trigger tenant_settings_touch before update on tenant_settings for each row execute function touch_updated_at();

-- ── tenant_modules (D-50) ─────────────────────────────────────────────────────
-- The key list must equal MODULE_KEYS in lib/modules.ts (tests assert it).
create table tenant_modules (
  tenant_id    uuid not null references tenants (id) on delete restrict,
  module_key   text not null check (module_key in
                 ('appointments', 'consultation', 'inventory', 'purchasing',
                  'pharmacy_counter', 'lab', 'expenses_finance', 'website')),
  enabled      boolean not null,
  changed_by   uuid,
  changed_at   timestamptz not null default now(),
  primary key (tenant_id, module_key)
);
comment on table tenant_modules is
  'Tenant on/off switch per module. Effective = business type ∧ plan ∧ this toggle ∧ dependencies (lib/modules.ts). Turning a module off never deletes data.';
comment on column tenant_modules.changed_by is 'tenant_members.id; FK added when tenant_members exists (B1).';

-- ── audit_log (D-23), append-only ─────────────────────────────────────────────
create table audit_log (
  id             bigserial primary key,
  tenant_id      uuid references tenants (id) on delete restrict,
  actor_kind     text not null check (actor_kind in ('member', 'platform_admin', 'patient_account', 'guest_token', 'system')),
  actor_id       uuid,
  session_level  text check (session_level in ('A1', 'A2', 'A3')),
  device_id      uuid,
  action         text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type    text,
  target_id      text,
  patient_id     uuid,
  outcome        text not null default 'success' check (outcome in ('success', 'denied', 'error')),
  reason         text,
  ip             inet,
  user_agent     text,
  detail         jsonb,
  created_at     timestamptz not null default now()
);
create index audit_log_tenant_time  on audit_log (tenant_id, created_at desc);
create index audit_log_patient_time on audit_log (tenant_id, patient_id, created_at desc) where patient_id is not null;
comment on table audit_log is
  'Append-only record of sensitive reads and writes (D-23). tenant_id null = platform event. detail never contains clinical text. No role may update or delete.';
comment on column audit_log.action is 'domain.verb, e.g. patient.chart_read, invoice.void, device.enroll.';

create trigger audit_log_no_update   before update or delete on audit_log for each row       execute function forbid_mutation();
create trigger audit_log_no_truncate before truncate          on audit_log for each statement execute function forbid_mutation();

-- ── access ────────────────────────────────────────────────────────────────────
alter table tenants          enable row level security;
alter table billing_profiles enable row level security;
alter table tenant_settings  enable row level security;
alter table tenant_modules   enable row level security;
alter table audit_log        enable row level security;

-- Defaults from 0001 gave service_role select/insert/update/delete. Narrow where needed:
revoke delete on tenants, billing_profiles, tenant_settings from service_role;  -- lifecycle is status, not deletion
revoke update, delete on audit_log from service_role;                          -- append-only
