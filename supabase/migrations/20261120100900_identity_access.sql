-- =============================================================================
-- 0010 IDENTITY & ACCESS (B1)
-- database.md §4; permissions.md §2–§6, §12; decisions D-24, D-27, D-30, D-52.
-- Owner defaults applied (2026-11-20): MFA mandatory for platform admins, tenant admins and
-- doctors (P-11); usernames allowed for staff, email required for tenant admins (P-18);
-- 6-digit PIN (P-19); a credential is verified by another tenant admin or, in a
-- single-admin tenant, by a platform admin, never by its holder (P-30, D-52).
-- =============================================================================

create type membership_role as enum ('tenant_admin', 'tenant_member');

-- ── members ───────────────────────────────────────────────────────────────────
create table tenant_members (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants (id) on delete restrict,
  auth_user_id     uuid references auth.users (id) on delete restrict,
  membership_role  membership_role not null default 'tenant_member',
  display_name     text not null check (length(btrim(display_name)) between 2 and 80),
  title            text,
  username         text check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  email            text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone            text,
  is_active        boolean not null default true,
  deleted_at       timestamptz,
  last_active_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, auth_user_id),
  -- P-18: a tenant admin signs in with a real email; staff may use a username instead.
  check (membership_role <> 'tenant_admin' or email is not null),
  check (email is not null or username is not null)
);
create unique index tenant_members_username on tenant_members (tenant_id, lower(username)) where username is not null;
create unique index tenant_members_email    on tenant_members (tenant_id, lower(email))    where email is not null;
comment on table tenant_members is
  'One row per person per tenant (D-24). auth_user_id is null until an invite is accepted. Checked LIVE on every request (deactivation is immediate).';
create trigger tenant_members_touch before update on tenant_members for each row execute function touch_updated_at();

-- FKs that had to wait for tenant_members (composite, D-03).
alter table tenant_modules add constraint tenant_modules_changed_by_fkey
  foreign key (tenant_id, changed_by) references tenant_members (tenant_id, id);
alter table postings add constraint postings_posted_by_fkey
  foreign key (tenant_id, posted_by) references tenant_members (tenant_id, id);

-- ── roles ─────────────────────────────────────────────────────────────────────
create table tenant_roles (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete restrict,
  name          text not null check (length(btrim(name)) between 2 and 60),
  description   text,
  permissions   text[] not null default '{}',
  home_route    text not null default '/employee/registrar' check (home_route ~ '^/(admin|employee)(/[a-z-]+)*$'),
  template_key  text references role_templates (key),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index tenant_roles_name on tenant_roles (tenant_id, lower(btrim(name)));
create trigger tenant_roles_touch before update on tenant_roles for each row execute function touch_updated_at();

-- Unknown keys can never be stored on a role (TS validates too; the DB is the backstop).
create or replace function tenant_roles_validate()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if exists (select 1 from unnest(new.permissions) p where p not in (select key from permission_catalog)) then
    raise exception 'UNKNOWN_PERMISSION' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger tenant_roles_validate before insert or update of permissions on tenant_roles
  for each row execute function tenant_roles_validate();

create table member_roles (
  tenant_id  uuid not null,
  member_id  uuid not null,
  role_id    uuid not null,
  primary key (member_id, role_id),
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id) on delete cascade,
  foreign key (tenant_id, role_id)   references tenant_roles (tenant_id, id)   on delete cascade
);

create table member_permission_overrides (
  tenant_id   uuid not null,
  member_id   uuid not null,
  permission  text not null references permission_catalog (key),
  effect      text not null check (effect in ('grant', 'revoke')),
  primary key (member_id, permission),
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id) on delete cascade
);

-- ── professional credentials (D-30, D-52) ─────────────────────────────────────
create table member_credentials (
  id                           uuid primary key default gen_random_uuid(),
  tenant_id                    uuid not null,
  member_id                    uuid not null,
  profession                   text not null check (profession in ('doctor', 'nurse', 'pharmacist', 'lab_technician')),
  council                      text not null,
  registration_no              text not null check (length(btrim(registration_no)) between 2 and 40),
  verified_by_member_id        uuid,
  verified_by_platform_admin   uuid references platform_admins (id),
  verified_at                  timestamptz,
  expires_on                   date,
  created_at                   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, profession, registration_no),
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id) on delete cascade,
  foreign key (tenant_id, verified_by_member_id) references tenant_members (tenant_id, id),
  check ((verified_at is null) = (verified_by_member_id is null and verified_by_platform_admin is null)),
  check (not (verified_by_member_id is not null and verified_by_platform_admin is not null)),
  check (verified_by_member_id is distinct from member_id)
);
comment on table member_credentials is
  'Professional registrations (NMC, nursing, pharmacy, health professional councils). A clinical permission is effective only with a VERIFIED, unexpired credential (D-30). The holder can never be the verifier (D-52).';

-- ── PINs, devices, attempts ───────────────────────────────────────────────────
create table member_pins (
  member_id      uuid primary key,
  tenant_id      uuid not null,
  pin_hash       text not null,
  set_at         timestamptz not null default now(),
  failed_count   smallint not null default 0,
  locked_until   timestamptz,
  must_change    boolean not null default false,
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id) on delete cascade
);
comment on table member_pins is
  'The 6-digit quick-access PIN (bcrypt). NEVER the Auth password (D-27). Usable only on a trusted device of the tenant. Lockout: 5 failures → 15 min, judged by the DB clock.';

create table trusted_devices (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete restrict,
  name                text not null check (length(btrim(name)) between 2 and 60),
  token_hash          text not null unique,
  enrolled_by         uuid not null,
  enrolled_at         timestamptz not null default now(),
  last_used_at        timestamptz,
  allowed_member_ids  uuid[],
  revoked_at          timestamptz,
  revoked_by          uuid,
  unique (tenant_id, id),
  foreign key (tenant_id, enrolled_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, revoked_by)  references tenant_members (tenant_id, id)
);
comment on table trusted_devices is
  'Devices an admin enrolled for PIN quick access (D-27). Only the HMAC of the device cookie is stored. Untrusted devices never see the staff picker.';

create table pin_attempts (
  id          bigserial primary key,
  tenant_id   uuid not null,
  member_id   uuid,
  device_id   uuid,
  ip          inet,
  success     boolean not null,
  reason      text,
  at          timestamptz not null default now()
);
create index pin_attempts_device_time on pin_attempts (device_id, at desc);

create table auth_login_attempts (
  id          bigserial primary key,
  login_hash  text not null,
  ip          inet,
  success     boolean not null,
  at          timestamptz not null default now()
);
create index auth_login_attempts_hash_time on auth_login_attempts (login_hash, at desc);
comment on table auth_login_attempts is
  'App-level password lockout on top of Supabase Auth rate limits: 10 failures in 15 minutes → locked for 15 minutes. login_hash = HMAC of the normalised login, never the login itself.';

-- ── session assurance (D-27) ──────────────────────────────────────────────────
create table session_assurance (
  session_id        uuid primary key,
  auth_user_id      uuid not null references auth.users (id) on delete cascade,
  tenant_id         uuid references tenants (id) on delete restrict,
  member_id         uuid,
  level             text not null check (level in ('A1', 'A2', 'A3')),
  method            text not null check (method in ('pin', 'password', 'mfa')),
  device_id         uuid references trusted_devices (id),
  password_auth_at  timestamptz,
  reauth_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '30 days',
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id) on delete cascade
);
comment on table session_assurance is
  'How strongly each Supabase session was authenticated (A1 PIN, A2 password, A3 password+MFA), keyed by the JWT session_id. Written only by server sign-in/step-up code.';
create trigger session_assurance_touch before update on session_assurance for each row execute function touch_updated_at();

-- ── access ────────────────────────────────────────────────────────────────────
alter table tenant_members              enable row level security;
alter table tenant_roles                enable row level security;
alter table member_roles                enable row level security;
alter table member_permission_overrides enable row level security;
alter table member_credentials          enable row level security;
alter table member_pins                 enable row level security;
alter table trusted_devices             enable row level security;
alter table pin_attempts                enable row level security;
alter table auth_login_attempts         enable row level security;
alter table session_assurance           enable row level security;

-- PIN hashes, attempts and lockout counters are reachable only through the functions below.
revoke all on member_pins, pin_attempts, auth_login_attempts from service_role;
revoke all on sequence pin_attempts_id_seq, auth_login_attempts_id_seq from service_role;
-- Device rows are readable (Admin → Devices) but written only through functions.
revoke insert, update, delete on trusted_devices from service_role;
-- Credential verification only through verify_member_credential().
revoke update on member_credentials from service_role;
grant update (council, registration_no, expires_on) on member_credentials to service_role;
revoke delete on tenant_members from service_role; -- people are deactivated, never deleted

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Effective modules of a tenant: mirror of lib/modules.ts effectiveModules().
-- Plan features arrive with plans in B2; until then no plan feature is held (lab stays off).
create or replace function effective_modules(p_tenant uuid)
returns text[]
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  v_bt text; v_set text[]; v_changed boolean := true; v_key text; v_req text[];
begin
  select business_type::text into v_bt from tenants where id = p_tenant;
  if v_bt is null then return '{}'; end if;
  select coalesce(array_agg(m.key order by m.key), '{}') into v_set
    from module_catalog m
    left join tenant_modules t on t.tenant_id = p_tenant and t.module_key = m.key
   where v_bt = any (m.business_types)
     and (m.plan_feature is null and true)  -- plan features: none until B2
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

-- Effective permissions of a member (permissions.md §4/§11). Mirror: lib/permissions.ts.
create or replace function effective_permissions(p_member uuid)
returns text[]
language sql stable
set search_path = pg_catalog, public
as $$
  with m as (
    select tm.id, tm.tenant_id, tm.membership_role
      from tenant_members tm join tenants t on t.id = tm.tenant_id
     where tm.id = p_member and tm.is_active and tm.deleted_at is null and t.status <> 'closed'
  ),
  mods as (select effective_modules(m.tenant_id) mods from m),
  profs as (
    select coalesce(array_agg(distinct c.profession), '{}') profs
      from member_credentials c, m
     where c.member_id = m.id and c.verified_at is not null
       and (c.expires_on is null or c.expires_on >= current_date)
  ),
  granted as (
    -- tenant_admin: every NON-clinical key implicitly (D-06: never clinical ones)
    select pc.key from permission_catalog pc, m
     where m.membership_role = 'tenant_admin' and pc.requires_profession is null
    union
    select unnest(r.permissions) from member_roles mr join tenant_roles r on r.id = mr.role_id, m
     where mr.member_id = m.id and r.is_active
    union
    select o.permission from member_permission_overrides o, m where o.member_id = m.id and o.effect = 'grant'
    except
    select o.permission from member_permission_overrides o, m where o.member_id = m.id and o.effect = 'revoke'
  )
  select coalesce(array_agg(g.key order by g.key), '{}')
    from granted g
    join permission_catalog pc on pc.key = g.key, mods, profs
   where (pc.module_key is null or pc.module_key = any (mods.mods))
     and (pc.requires_profession is null or pc.requires_profession && profs.profs);
$$;

-- One round trip for every authenticated request (architecture.md §4).
create or replace function resolve_request_context(p_auth_user uuid, p_session uuid, p_tenant uuid default null)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  v_member tenant_members; v_tenant tenants; v_count int; v_sa session_assurance; v_roles jsonb; v_profs text[];
begin
  select count(*) into v_count
    from tenant_members tm join tenants t on t.id = tm.tenant_id
   where tm.auth_user_id = p_auth_user and tm.is_active and tm.deleted_at is null and t.status <> 'closed'
     and (p_tenant is null or tm.tenant_id = p_tenant);
  if v_count = 0 then return null; end if;
  -- P-16: multi-tenant membership is hidden in the MVP; the most recently active one wins.
  select tm.* into v_member
    from tenant_members tm join tenants t on t.id = tm.tenant_id
   where tm.auth_user_id = p_auth_user and tm.is_active and tm.deleted_at is null and t.status <> 'closed'
     and (p_tenant is null or tm.tenant_id = p_tenant)
   order by tm.last_active_at desc nulls last, tm.created_at
   limit 1;
  select * into v_tenant from tenants where id = v_member.tenant_id;
  select * into v_sa from session_assurance
   where session_id = p_session and auth_user_id = p_auth_user and expires_at > now();
  select coalesce(jsonb_agg(jsonb_build_object('name', r.name, 'home_route', r.home_route, 'template_key', r.template_key) order by r.created_at), '[]')
    into v_roles
    from member_roles mr join tenant_roles r on r.id = mr.role_id
   where mr.member_id = v_member.id and r.is_active;
  select coalesce(array_agg(distinct profession), '{}') into v_profs
    from member_credentials where member_id = v_member.id and verified_at is not null
     and (expires_on is null or expires_on >= current_date);
  return jsonb_build_object(
    'member_id', v_member.id,
    'tenant_id', v_tenant.id,
    'tenant_slug', v_tenant.slug,
    'tenant_name', v_tenant.name,
    'tenant_status', v_tenant.status,
    'business_type', v_tenant.business_type,
    'membership_role', v_member.membership_role,
    'display_name', v_member.display_name,
    'memberships', v_count,
    'roles', v_roles,
    'professions', to_jsonb(v_profs),
    'permissions', to_jsonb(effective_permissions(v_member.id)),
    'modules', to_jsonb(effective_modules(v_tenant.id)),
    'assurance', case when v_sa.session_id is null then null else jsonb_build_object(
      'level', v_sa.level, 'method', v_sa.method, 'device_id', v_sa.device_id,
      'password_auth_at', v_sa.password_auth_at, 'reauth_at', v_sa.reauth_at, 'tenant_id', v_sa.tenant_id) end,
    'pin_policy', (select pin_policy from tenant_settings where tenant_id = v_tenant.id),
    'shift_window_hours', (select shift_window_hours from tenant_settings where tenant_id = v_tenant.id),
    'idle_lock_minutes', (select idle_lock_minutes from tenant_settings where tenant_id = v_tenant.id)
  );
end $$;

-- Copy the seeded role templates into a tenant (called by provisioning in B2 and by the dev seed).
create or replace function seed_role_templates(p_tenant uuid)
returns integer
language sql
set search_path = pg_catalog, public
as $$
  with ins as (
    insert into tenant_roles (tenant_id, name, permissions, home_route, template_key)
    select p_tenant, t.name, t.permissions, t.home_route, t.key from role_templates t where t.seeded
    on conflict do nothing
    returning 1
  ) select count(*)::int from ins;
$$;

-- ── PIN ──────────────────────────────────────────────────────────────────────
create or replace function set_member_pin(p_tenant uuid, p_member uuid, p_pin text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_pin !~ '^\d{6}$' then raise exception 'PIN_FORMAT' using errcode = 'P0001'; end if;
  if p_pin ~ '^(\d)\1{5}$' or strpos('0123456789012', p_pin) > 0 or strpos('9876543210987', p_pin) > 0 then
    raise exception 'PIN_TOO_SIMPLE' using errcode = 'P0001';
  end if;
  if not exists (select 1 from tenant_members where id = p_member and tenant_id = p_tenant and is_active and deleted_at is null) then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0001';
  end if;
  insert into member_pins (member_id, tenant_id, pin_hash) values (p_member, p_tenant, crypt(p_pin, gen_salt('bf', 10)))
  on conflict (member_id) do update
    set pin_hash = excluded.pin_hash, set_at = now(), failed_count = 0, locked_until = null, must_change = false;
end $$;

-- An admin reset never sets a PIN for someone; it forces them to choose a new one (W-20).
create or replace function require_pin_change(p_tenant uuid, p_member uuid)
returns void
language sql security definer
set search_path = pg_catalog, public
as $$
  update member_pins set must_change = true, failed_count = 0, locked_until = null
   where member_id = p_member and tenant_id = p_tenant;
$$;

create or replace function member_has_pin(p_member uuid)
returns boolean
language sql security definer stable
set search_path = pg_catalog, public
as $$ select exists (select 1 from member_pins where member_id = p_member and not must_change) $$;

-- Verify a PIN on a trusted device (L4). Returns a row instead of raising, so the attempt
-- record survives a failure. reason: null on success, else DEVICE_NOT_TRUSTED |
-- DEVICE_THROTTLED | NOT_ALLOWED | PIN_NOT_SET | PIN_LOCKED | BAD_PIN.
create or replace function verify_pin(p_tenant uuid, p_member uuid, p_pin text, p_device_token_hash text, p_ip inet default null)
returns table (ok boolean, reason text, retry_after timestamptz, auth_user_id uuid, device_id uuid)
language plpgsql security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_dev trusted_devices; v_mem tenant_members; v_pin member_pins; v_fail int; v_policy text; v_status tenant_status;
begin
  select * into v_dev from trusted_devices
   where token_hash = p_device_token_hash and tenant_id = p_tenant and revoked_at is null;
  if v_dev.id is null then
    return query select false, 'DEVICE_NOT_TRUSTED', null::timestamptz, null::uuid, null::uuid; return;
  end if;

  select count(*) into v_fail from pin_attempts
   where device_id = v_dev.id and not success and at > now() - interval '1 hour';
  if v_fail >= 20 then
    return query select false, 'DEVICE_THROTTLED', now() + interval '1 hour', null::uuid, v_dev.id; return;
  end if;

  select t.status, s.pin_policy into v_status, v_policy
    from tenants t left join tenant_settings s on s.tenant_id = t.id where t.id = p_tenant;
  select * into v_mem from tenant_members
   where id = p_member and tenant_id = p_tenant and is_active and deleted_at is null and auth_user_id is not null;
  if v_mem.id is null or v_status <> 'active' or coalesce(v_policy, 'allowed') = 'off'
     or (v_dev.allowed_member_ids is not null and not (p_member = any (v_dev.allowed_member_ids))) then
    insert into pin_attempts (tenant_id, member_id, device_id, ip, success, reason) values (p_tenant, p_member, v_dev.id, p_ip, false, 'NOT_ALLOWED');
    return query select false, 'NOT_ALLOWED', null::timestamptz, null::uuid, v_dev.id; return;
  end if;

  select * into v_pin from member_pins where member_id = p_member for update;
  if v_pin.member_id is null or v_pin.must_change then
    return query select false, 'PIN_NOT_SET', null::timestamptz, null::uuid, v_dev.id; return;
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    -- A locked PIN refuses even the RIGHT digits (HRestroSewa's lockout rule).
    insert into pin_attempts (tenant_id, member_id, device_id, ip, success, reason) values (p_tenant, p_member, v_dev.id, p_ip, false, 'PIN_LOCKED');
    return query select false, 'PIN_LOCKED', v_pin.locked_until, null::uuid, v_dev.id; return;
  end if;

  if crypt(p_pin, v_pin.pin_hash) <> v_pin.pin_hash then
    if v_pin.failed_count + 1 >= 5 then
      update member_pins set failed_count = 0, locked_until = now() + interval '15 minutes' where member_id = p_member;
      insert into pin_attempts (tenant_id, member_id, device_id, ip, success, reason) values (p_tenant, p_member, v_dev.id, p_ip, false, 'PIN_LOCKED');
      return query select false, 'PIN_LOCKED', now() + interval '15 minutes', null::uuid, v_dev.id; return;
    end if;
    update member_pins set failed_count = failed_count + 1 where member_id = p_member;
    insert into pin_attempts (tenant_id, member_id, device_id, ip, success, reason) values (p_tenant, p_member, v_dev.id, p_ip, false, 'BAD_PIN');
    return query select false, 'BAD_PIN', null::timestamptz, null::uuid, v_dev.id; return;
  end if;

  update member_pins set failed_count = 0, locked_until = null where member_id = p_member;
  update trusted_devices set last_used_at = now() where id = v_dev.id;
  insert into pin_attempts (tenant_id, member_id, device_id, ip, success) values (p_tenant, p_member, v_dev.id, p_ip, true);
  return query select true, null::text, null::timestamptz, v_mem.auth_user_id, v_dev.id;
end $$;

-- Staff picker for a trusted device: only active, PIN-enabled, allowed members. Returns
-- nothing for an untrusted device, so the list is never public (closes HRestroSewa's gap).
create or replace function device_staff_picker(p_tenant uuid, p_device_token_hash text)
returns table (member_id uuid, display_name text, title text)
language sql security definer stable
set search_path = pg_catalog, public
as $$
  select tm.id, tm.display_name, tm.title
    from trusted_devices d
    join tenants t on t.id = d.tenant_id and t.status = 'active'
    left join tenant_settings s on s.tenant_id = t.id
    join tenant_members tm on tm.tenant_id = d.tenant_id
    join member_pins p on p.member_id = tm.id and not p.must_change
   where d.tenant_id = p_tenant and d.token_hash = p_device_token_hash and d.revoked_at is null
     and coalesce(s.pin_policy, 'allowed') <> 'off'
     and tm.is_active and tm.deleted_at is null and tm.auth_user_id is not null
     and (d.allowed_member_ids is null or tm.id = any (d.allowed_member_ids))
   order by tm.display_name;
$$;

-- ── trusted devices ──────────────────────────────────────────────────────────
create or replace function enroll_trusted_device(p_tenant uuid, p_name text, p_token_hash text, p_by uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid;
begin
  if not exists (select 1 from tenant_members where id = p_by and tenant_id = p_tenant and is_active and deleted_at is null) then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0001';
  end if;
  insert into trusted_devices (tenant_id, name, token_hash, enrolled_by) values (p_tenant, btrim(p_name), p_token_hash, p_by)
  returning id into v_id;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, 'device.enroll', 'trusted_device', v_id::text, 'success', jsonb_build_object('name', btrim(p_name)));
  return v_id;
end $$;

create or replace function revoke_trusted_device(p_tenant uuid, p_device uuid, p_by uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  update trusted_devices set revoked_at = now(), revoked_by = p_by
   where id = p_device and tenant_id = p_tenant and revoked_at is null;
  if not found then raise exception 'DEVICE_NOT_FOUND' using errcode = 'P0001'; end if;
  -- PIN sessions minted on the device lose their assurance immediately.
  delete from session_assurance where device_id = p_device;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome)
  values (p_tenant, 'member', p_by, 'device.revoke', 'trusted_device', p_device::text, 'success');
end $$;

-- ── password lockout (app level, on top of Supabase Auth rate limits) ────────
create or replace function password_lockout_status(p_login_hash text)
returns table (locked boolean, retry_after timestamptz)
language sql security definer stable
set search_path = pg_catalog, public
as $$
  with last_ok as (
    select max(at) t from auth_login_attempts where login_hash = p_login_hash and success
  ), fails as (
    select count(*) n, max(at) last_fail from auth_login_attempts, last_ok
     where login_hash = p_login_hash and not success
       and at > greatest(now() - interval '15 minutes', coalesce(last_ok.t, '-infinity'))
  )
  select n >= 10, case when n >= 10 then last_fail + interval '15 minutes' end from fails;
$$;

create or replace function record_login_attempt(p_login_hash text, p_success boolean, p_ip inet default null)
returns void
language sql security definer
set search_path = pg_catalog, public
as $$ insert into auth_login_attempts (login_hash, success, ip) values (p_login_hash, p_success, p_ip) $$;

-- ── credential verification (D-52, P-30) ─────────────────────────────────────
create or replace function verify_member_credential(p_credential uuid, p_verifier_member uuid, p_verifier_platform_admin uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_c member_credentials; v_ok boolean;
begin
  if (p_verifier_member is null) = (p_verifier_platform_admin is null) then
    raise exception 'ONE_VERIFIER_REQUIRED' using errcode = 'P0001';
  end if;
  select * into v_c from member_credentials where id = p_credential for update;
  if v_c.id is null then raise exception 'CREDENTIAL_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_verifier_member is not null then
    if p_verifier_member = v_c.member_id then raise exception 'CANNOT_VERIFY_OWN_CREDENTIAL' using errcode = 'P0001'; end if;
    select exists (select 1 from tenant_members where id = p_verifier_member and tenant_id = v_c.tenant_id
                    and membership_role = 'tenant_admin' and is_active and deleted_at is null) into v_ok;
    if not v_ok then raise exception 'VERIFIER_NOT_TENANT_ADMIN' using errcode = 'P0001'; end if;
  else
    select exists (select 1 from platform_admins where id = p_verifier_platform_admin and is_active) into v_ok;
    if not v_ok then raise exception 'VERIFIER_NOT_PLATFORM_ADMIN' using errcode = 'P0001'; end if;
  end if;
  update member_credentials
     set verified_by_member_id = p_verifier_member, verified_by_platform_admin = p_verifier_platform_admin, verified_at = now()
   where id = p_credential;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (v_c.tenant_id, case when p_verifier_member is null then 'platform_admin' else 'member' end,
          coalesce(p_verifier_member, p_verifier_platform_admin), 'member.credential_verify', 'member_credential',
          p_credential::text, 'success', jsonb_build_object('profession', v_c.profession, 'member_id', v_c.member_id));
end $$;

-- ── privileges ───────────────────────────────────────────────────────────────
revoke all on function effective_modules(uuid)                                   from public, anon, authenticated;
revoke all on function effective_permissions(uuid)                               from public, anon, authenticated;
revoke all on function resolve_request_context(uuid, uuid, uuid)                 from public, anon, authenticated;
revoke all on function seed_role_templates(uuid)                                 from public, anon, authenticated;
revoke all on function tenant_roles_validate()                                   from public, anon, authenticated, service_role;
revoke all on function set_member_pin(uuid, uuid, text)                          from public, anon, authenticated;
revoke all on function require_pin_change(uuid, uuid)                            from public, anon, authenticated;
revoke all on function member_has_pin(uuid)                                      from public, anon, authenticated;
revoke all on function verify_pin(uuid, uuid, text, text, inet)                  from public, anon, authenticated;
revoke all on function device_staff_picker(uuid, text)                           from public, anon, authenticated;
revoke all on function enroll_trusted_device(uuid, text, text, uuid)             from public, anon, authenticated;
revoke all on function revoke_trusted_device(uuid, uuid, uuid)                   from public, anon, authenticated;
revoke all on function password_lockout_status(text)                             from public, anon, authenticated;
revoke all on function record_login_attempt(text, boolean, inet)                 from public, anon, authenticated;
revoke all on function verify_member_credential(uuid, uuid, uuid)                from public, anon, authenticated;

grant execute on function effective_modules(uuid)                       to service_role;
grant execute on function effective_permissions(uuid)                   to service_role;
grant execute on function resolve_request_context(uuid, uuid, uuid)     to service_role;
grant execute on function seed_role_templates(uuid)                     to service_role;
grant execute on function set_member_pin(uuid, uuid, text)              to service_role;
grant execute on function require_pin_change(uuid, uuid)                to service_role;
grant execute on function member_has_pin(uuid)                          to service_role;
grant execute on function verify_pin(uuid, uuid, text, text, inet)      to service_role;
grant execute on function device_staff_picker(uuid, text)               to service_role;
grant execute on function enroll_trusted_device(uuid, text, text, uuid) to service_role;
grant execute on function revoke_trusted_device(uuid, uuid, uuid)       to service_role;
grant execute on function password_lockout_status(text)                 to service_role;
grant execute on function record_login_attempt(text, boolean, inet)     to service_role;
grant execute on function verify_member_credential(uuid, uuid, uuid)    to service_role;
