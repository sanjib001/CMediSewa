-- =============================================================================
-- 0008 PLATFORM ADMINS: the Super Admin authority (first slice of B1)
-- database.md §3; permissions.md §2/§10; D-08.
--
-- Super Admins are NOT tenant members (HRestroSewa's `super_admins` pattern): a separate
-- table, checked live on every request by requireSuperAdmin(). They never see patient,
-- stock or money detail of a tenant (D-08).
-- TOTP is mandatory for this role (L1). Enrolment is enforced by the B1 sign-in flow, so
-- an account created before B1 has a password only until its first sign-in.
-- =============================================================================

create table platform_admins (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid not null unique references auth.users (id) on delete restrict,
  display_name  text not null check (length(btrim(display_name)) between 2 and 80),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table platform_admins is
  'Super Admin authority (platform operators). Separate from tenant_members; checked live on every request; never grants tenant patient/stock/money access (D-08).';
create trigger platform_admins_touch before update on platform_admins for each row execute function touch_updated_at();

alter table platform_admins enable row level security;
-- The app only READS this table (guards). Creating or removing a platform admin is an
-- operator action (scripts/create-platform-admin.mjs, later a guarded B2 screen).
revoke insert, update, delete on platform_admins from service_role;
