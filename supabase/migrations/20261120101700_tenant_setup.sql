-- =============================================================================
-- 0018 TENANT SETUP (B3): departments, services, doctors, OPD schedules, exceptions,
-- availability, clinic website content, store access, staff invites/roles, go-live.
-- database.md §5–§7; workflows W-02, W-03, W-06; decisions D-30, D-34, D-46, D-52.
-- =============================================================================

-- ── departments & services ────────────────────────────────────────────────────
create table departments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete restrict,
  name         text not null check (length(btrim(name)) between 2 and 60),
  description  text,
  is_active    boolean not null default true,
  sort_order   smallint not null default 0,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index departments_name on departments (tenant_id, lower(btrim(name)));

create table services (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete restrict,
  department_id     uuid,
  name              text not null check (length(btrim(name)) between 2 and 80),
  kind              text not null default 'consultation' check (kind in ('consultation', 'procedure', 'lab', 'other')),
  price_npr         numeric(12,2) not null check (price_npr >= 0),
  duration_minutes  smallint check (duration_minutes between 1 and 480),
  tax_category      text not null default 'exempt' check (tax_category in ('exempt', 'vat13')),
  is_public         boolean not null default true,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, department_id) references departments (tenant_id, id)
);
create unique index services_name on services (tenant_id, lower(btrim(name)));
comment on column services.tax_category is 'VAT treatment (P-08/P-27, to verify). Health services are assumed exempt until counsel confirms.';

-- ── doctors ───────────────────────────────────────────────────────────────────
create table doctor_profiles (
  member_id         uuid primary key,
  tenant_id         uuid not null,
  specialty         text,
  qualification     text,
  bio               text check (length(bio) <= 1500),
  consultation_fee  numeric(12,2) check (consultation_fee >= 0),
  room              text,
  is_public         boolean not null default true,
  public_slug       text check (public_slug ~ '^[a-z0-9-]{2,60}$'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, member_id),
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id) on delete cascade
);
create unique index doctor_profiles_slug on doctor_profiles (tenant_id, public_slug) where public_slug is not null;
create trigger doctor_profiles_touch before update on doctor_profiles for each row execute function touch_updated_at();
comment on table doctor_profiles is 'OPD doctors. Listed publicly only with is_public AND a verified doctor credential (D-30).';

create table doctor_departments (
  tenant_id      uuid not null,
  member_id      uuid not null,
  department_id  uuid not null,
  primary key (member_id, department_id),
  foreign key (tenant_id, member_id) references doctor_profiles (tenant_id, member_id) on delete cascade,
  foreign key (tenant_id, department_id) references departments (tenant_id, id) on delete cascade
);

create table doctor_services (
  tenant_id       uuid not null,
  member_id       uuid not null,
  service_id      uuid not null,
  price_override  numeric(12,2) check (price_override >= 0),
  primary key (member_id, service_id),
  foreign key (tenant_id, member_id) references doctor_profiles (tenant_id, member_id) on delete cascade,
  foreign key (tenant_id, service_id) references services (tenant_id, id) on delete cascade
);

-- ── OPD schedules (weekly templates with effective dating) ────────────────────
create table doctor_schedules (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  member_id       uuid not null,
  weekday         smallint not null check (weekday between 0 and 6),   -- 0 = Sunday (Postgres dow)
  start_time      time not null,
  end_time        time not null,
  start_minute    integer generated always as ((extract(hour from start_time) * 60 + extract(minute from start_time))::int) stored,
  end_minute      integer generated always as ((extract(hour from end_time) * 60 + extract(minute from end_time))::int) stored,
  slot_minutes    smallint check (slot_minutes between 5 and 240),
  max_tokens      smallint check (max_tokens between 1 and 500),
  room            text,
  effective_from  date not null default current_date,
  effective_to    date,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, member_id) references doctor_profiles (tenant_id, member_id) on delete cascade,
  check (end_time > start_time),
  check (effective_to is null or effective_to >= effective_from),
  -- P-03 "both": a window is either time slots (slot_minutes) or a token OPD (max_tokens).
  check ((slot_minutes is null) <> (max_tokens is null)),
  -- Overlapping OPD windows for the same doctor on the same weekday are impossible.
  exclude using gist (
    tenant_id with =, member_id with =, weekday with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&,
    int4range(start_minute, end_minute) with &&
  )
);
comment on table doctor_schedules is 'Weekly OPD templates (W-06). slot_minutes = time-slot booking; max_tokens = token OPD (P-03: both). A change applies from effective_from, so existing bookings are not rewritten.';

create table schedule_exceptions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  member_id   uuid not null,
  on_date     date not null,
  kind        text not null check (kind in ('leave', 'extra', 'modified')),
  start_time  time,
  end_time    time,
  slot_minutes smallint check (slot_minutes between 5 and 240),
  max_tokens  smallint check (max_tokens between 1 and 500),
  reason      text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, member_id) references doctor_profiles (tenant_id, member_id) on delete cascade,
  check ((start_time is null) = (end_time is null)),
  check (start_time is null or end_time > start_time),
  check (kind = 'leave' or start_time is not null),
  check (kind = 'leave' or ((slot_minutes is null) <> (max_tokens is null)))
);
comment on table schedule_exceptions is 'Leave (whole day when no times, else the given hours), extra OPD windows, or a modified day replacing the template.';

-- Availability windows → slots for a doctor between two dates (inclusive), in the tenant's
-- timezone. Pure schedule availability: B4 subtracts booked appointments and booking rules.
create or replace function available_slots(p_tenant uuid, p_doctor uuid, p_from date, p_to date)
returns table (slot_start timestamptz, slot_end timestamptz, mode text, capacity integer, room text)
language plpgsql stable
set search_path = pg_catalog, public
as $$
#variable_conflict use_variable
declare
  v_tz text; v_d date; w record; v_t time; v_step interval; v_has_mod boolean; v_full_leave boolean;
begin
  select timezone into v_tz from tenants where id = p_tenant;
  if v_tz is null or p_to < p_from or p_to - p_from > 92 then return; end if;
  for v_d in select generate_series(p_from, p_to, interval '1 day')::date loop
    select exists (select 1 from schedule_exceptions e where e.tenant_id = p_tenant and e.member_id = p_doctor
                    and e.on_date = v_d and e.kind = 'leave' and e.start_time is null) into v_full_leave;
    continue when v_full_leave;
    select exists (select 1 from schedule_exceptions e where e.tenant_id = p_tenant and e.member_id = p_doctor
                    and e.on_date = v_d and e.kind = 'modified') into v_has_mod;
    for w in
      select s.start_time st, s.end_time et, s.slot_minutes sm, s.max_tokens mt, s.room rm
        from doctor_schedules s
       where not v_has_mod and s.tenant_id = p_tenant and s.member_id = p_doctor
         and s.weekday = extract(dow from v_d) and s.effective_from <= v_d and (s.effective_to is null or s.effective_to >= v_d)
      union all
      select e.start_time, e.end_time, e.slot_minutes, e.max_tokens, null
        from schedule_exceptions e
       where e.tenant_id = p_tenant and e.member_id = p_doctor and e.on_date = v_d and e.kind in ('extra', 'modified')
      order by 1
    loop
      if w.sm is null then
        if not exists (select 1 from schedule_exceptions e where e.tenant_id = p_tenant and e.member_id = p_doctor and e.on_date = v_d
                        and e.kind = 'leave' and e.start_time < w.et and e.end_time > w.st) then
          slot_start := (v_d + w.st) at time zone v_tz; slot_end := (v_d + w.et) at time zone v_tz;
          mode := 'token'; capacity := w.mt; room := w.rm; return next;
        end if;
      else
        v_step := make_interval(mins => w.sm);
        v_t := w.st;
        while v_t + v_step <= w.et and v_t >= w.st loop
          if not exists (select 1 from schedule_exceptions e where e.tenant_id = p_tenant and e.member_id = p_doctor and e.on_date = v_d
                          and e.kind = 'leave' and e.start_time < v_t + v_step and e.end_time > v_t) then
            slot_start := (v_d + v_t) at time zone v_tz; slot_end := (v_d + v_t + v_step) at time zone v_tz;
            mode := 'slot'; capacity := 1; room := w.rm; return next;
          end if;
          v_t := v_t + v_step;
          exit when v_t = '00:00'::time;  -- wrapped past midnight
        end loop;
      end if;
    end loop;
  end loop;
end $$;

-- ── clinic website (D-34) ─────────────────────────────────────────────────────
create table site_settings (
  tenant_id                  uuid primary key references tenants (id) on delete restrict,
  published                  boolean not null default false,
  theme_color                text not null default '#0f5c4d' check (theme_color ~ '^#[0-9a-fA-F]{6}$'),
  hero_title                 text check (length(hero_title) <= 120),
  hero_subtitle              text check (length(hero_subtitle) <= 240),
  about_md                   text check (length(about_md) <= 4000),
  contact_phone              text,
  contact_email              text,
  whatsapp                   text,
  map_url                    text check (map_url is null or map_url ~ '^https://'),
  hours_text                 text check (length(hours_text) <= 300),
  seo_title                  text check (length(seo_title) <= 70),
  seo_description            text check (length(seo_description) <= 170),
  show_prices                boolean not null default true,
  show_registration_numbers  boolean not null default true,
  booking_enabled            boolean not null default false,
  published_at               timestamptz,
  updated_by                 uuid,
  updated_at                 timestamptz not null default now(),
  foreign key (tenant_id, updated_by) references tenant_members (tenant_id, id)
);
create trigger site_settings_touch before update on site_settings for each row execute function touch_updated_at();
comment on table site_settings is 'The clinic''s public website content, edited in Admin → Clinic website. Plain text/Markdown only (no HTML). Read publicly ONLY through public_clinic_profile().';

create table site_announcements (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete restrict,
  title       text not null check (length(btrim(title)) between 2 and 120),
  body_md     text check (length(body_md) <= 1500),
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  is_pinned   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  check (ends_at is null or ends_at > starts_at)
);
create table site_faqs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete restrict,
  question    text not null check (length(btrim(question)) between 3 and 200),
  answer_md   text not null check (length(answer_md) <= 2000),
  sort_order  smallint not null default 0,
  unique (tenant_id, id)
);

-- ── store access (D-46; used by B5 inventory) ─────────────────────────────────
create table store_members (
  tenant_id  uuid not null,
  store_id   uuid not null,
  member_id  uuid not null,
  access     text not null check (access in ('view', 'operate', 'manage')),
  primary key (store_id, member_id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade,
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id) on delete cascade
);

-- ── access ────────────────────────────────────────────────────────────────────
alter table departments         enable row level security;
alter table services            enable row level security;
alter table doctor_profiles     enable row level security;
alter table doctor_departments  enable row level security;
alter table doctor_services     enable row level security;
alter table doctor_schedules    enable row level security;
alter table schedule_exceptions enable row level security;
alter table site_settings       enable row level security;
alter table site_announcements  enable row level security;
alter table site_faqs           enable row level security;
alter table store_members       enable row level security;
revoke delete on departments, services from service_role;  -- deactivate instead (history)

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- The ONLY public read of a clinic (D-34, security.md §8): allow-listed fields of an ACTIVE
-- clinic with a PUBLISHED website. Doctors are listed only with a verified doctor credential.
create or replace function public_clinic_profile(p_slug text)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_t tenants; v_s site_settings;
begin
  select * into v_t from tenants where slug = p_slug and status = 'active';
  if v_t.id is null then return null; end if;
  select * into v_s from site_settings where tenant_id = v_t.id and published;
  if v_s.tenant_id is null then return null; end if;
  return jsonb_build_object(
    'name', v_t.name,
    'slug', v_t.slug,
    'address', concat_ws(', ', nullif(v_t.address_street, ''), nullif(v_t.address_ward, ''), nullif(v_t.address_municipality, ''), nullif(v_t.address_district, '')),
    'phone', coalesce(v_s.contact_phone, v_t.phone),
    'email', v_s.contact_email,
    'whatsapp', v_s.whatsapp,
    'map_url', v_s.map_url,
    'hours', v_s.hours_text,
    'theme_color', v_s.theme_color,
    'hero_title', coalesce(v_s.hero_title, v_t.name),
    'hero_subtitle', v_s.hero_subtitle,
    'about', v_s.about_md,
    'seo_title', v_s.seo_title,
    'seo_description', v_s.seo_description,
    'booking_enabled', v_s.booking_enabled,
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'description', d.description) order by d.sort_order, d.name)
                     from departments d where d.tenant_id = v_t.id and d.is_active), '[]'),
    'services', coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'kind', s.kind,
                     'price', case when v_s.show_prices then s.price_npr end) order by s.kind, s.name)
                     from services s where s.tenant_id = v_t.id and s.is_active and s.is_public), '[]'),
    'doctors', coalesce((select jsonb_agg(jsonb_build_object(
                     'id', dp.member_id, 'name', m.display_name, 'specialty', dp.specialty, 'qualification', dp.qualification,
                     'bio', dp.bio, 'fee', case when v_s.show_prices then dp.consultation_fee end,
                     'registration', case when v_s.show_registration_numbers then c.council || ' ' || c.registration_no end,
                     'opd', (select jsonb_agg(distinct jsonb_build_object('weekday', ds.weekday, 'start', to_char(ds.start_time, 'HH24:MI'), 'end', to_char(ds.end_time, 'HH24:MI')))
                               from doctor_schedules ds where ds.member_id = dp.member_id and ds.effective_from <= current_date
                                 and (ds.effective_to is null or ds.effective_to >= current_date))) order by m.display_name)
                     from doctor_profiles dp
                     join tenant_members m on m.id = dp.member_id and m.is_active and m.deleted_at is null
                     join member_credentials c on c.member_id = dp.member_id and c.profession = 'doctor' and c.verified_at is not null
                                              and (c.expires_on is null or c.expires_on >= current_date)
                    where dp.tenant_id = v_t.id and dp.is_public), '[]'),
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('title', a.title, 'body', a.body_md) order by a.is_pinned desc, a.starts_at desc)
                     from site_announcements a where a.tenant_id = v_t.id and a.starts_at <= now() and (a.ends_at is null or a.ends_at > now())), '[]'),
    'faqs', coalesce((select jsonb_agg(jsonb_build_object('q', f.question, 'a', f.answer_md) order by f.sort_order)
                     from site_faqs f where f.tenant_id = v_t.id), '[]')
  );
end $$;

-- Invite a staff member (W-03): the member row and its one-time invite link in one step.
create or replace function invite_member(
  p_tenant uuid, p_display_name text, p_email text, p_username text, p_title text,
  p_membership_role membership_role, p_role_ids uuid[], p_token_hash text, p_by uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_member uuid;
begin
  if not exists (select 1 from tenant_members where id = p_by and tenant_id = p_tenant and is_active) then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0001';
  end if;
  insert into tenant_members (tenant_id, membership_role, display_name, email, username, title)
  values (p_tenant, p_membership_role, btrim(p_display_name), nullif(lower(btrim(p_email)), ''), nullif(lower(btrim(p_username)), ''), nullif(btrim(p_title), ''))
  returning id into v_member;
  insert into member_roles (tenant_id, member_id, role_id) select p_tenant, v_member, unnest(coalesce(p_role_ids, '{}'));
  insert into member_invites (tenant_id, member_id, token_hash, created_by_member) values (p_tenant, v_member, p_token_hash, p_by);
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, 'member.invite', 'tenant_member', v_member::text, 'success',
          jsonb_build_object('membership_role', p_membership_role, 'roles', p_role_ids));
  return v_member;
end $$;

create or replace function reissue_member_invite(p_tenant uuid, p_member uuid, p_token_hash text, p_by uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from tenant_members where id = p_member and tenant_id = p_tenant and auth_user_id is null and is_active) then
    raise exception 'MEMBER_NOT_INVITABLE' using errcode = 'P0001';
  end if;
  update member_invites set revoked_at = now() where member_id = p_member and used_at is null and revoked_at is null;
  insert into member_invites (tenant_id, member_id, token_hash, created_by_member) values (p_tenant, p_member, p_token_hash, p_by);
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome)
  values (p_tenant, 'member', p_by, 'member.invite_reissue', 'tenant_member', p_member::text, 'success');
end $$;

-- Replace a member's roles in one step, with before/after in the audit log.
create or replace function set_member_roles(p_tenant uuid, p_member uuid, p_role_ids uuid[], p_by uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_before uuid[];
begin
  if not exists (select 1 from tenant_members where id = p_member and tenant_id = p_tenant) then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(role_id), '{}') into v_before from member_roles where member_id = p_member;
  delete from member_roles where member_id = p_member;
  insert into member_roles (tenant_id, member_id, role_id) select p_tenant, p_member, unnest(coalesce(p_role_ids, '{}'));
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, 'member.roles_change', 'tenant_member', p_member::text, 'success',
          jsonb_build_object('before', v_before, 'after', p_role_ids));
end $$;

-- Deactivate / reactivate. The last active clinic admin can never be deactivated.
create or replace function set_member_active(p_tenant uuid, p_member uuid, p_active boolean, p_by uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_role membership_role;
begin
  select membership_role into v_role from tenant_members where id = p_member and tenant_id = p_tenant for update;
  if v_role is null then raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0001'; end if;
  if not p_active and v_role = 'tenant_admin' and (select count(*) from tenant_members where tenant_id = p_tenant
      and membership_role = 'tenant_admin' and is_active and deleted_at is null and id <> p_member) = 0 then
    raise exception 'LAST_ADMIN' using errcode = 'P0001';
  end if;
  update tenant_members set is_active = p_active where id = p_member;
  if not p_active then delete from session_assurance where member_id = p_member; end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome)
  values (p_tenant, 'member', p_by, case when p_active then 'member.reactivate' else 'member.deactivate' end, 'tenant_member', p_member::text, 'success');
end $$;

-- What still blocks go-live (W-02). Empty array = ready.
create or replace function go_live_blockers(p_tenant uuid)
returns text[]
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_mods text[] := effective_modules(p_tenant); v_out text[] := '{}'; v_t tenants;
begin
  select * into v_t from tenants where id = p_tenant;
  if coalesce(btrim(v_t.phone), '') = '' then v_out := v_out || 'clinic_phone'; end if;
  if not exists (select 1 from billing_profiles where tenant_id = p_tenant and is_default and is_active and coalesce(btrim(legal_name), '') <> '') then
    v_out := v_out || 'billing_profile';
  end if;
  if 'appointments' = any (v_mods) then
    if not exists (select 1 from services where tenant_id = p_tenant and is_active and kind = 'consultation') then v_out := v_out || 'consultation_service'; end if;
    if not exists (select 1 from doctor_profiles dp join tenant_members m on m.id = dp.member_id and m.is_active
                    join doctor_schedules s on s.member_id = dp.member_id where dp.tenant_id = p_tenant) then
      v_out := v_out || 'doctor_with_schedule';
    end if;
  end if;
  if 'pharmacy_counter' = any (v_mods) and not exists (select 1 from stores where tenant_id = p_tenant and kind = 'pharmacy' and is_active) then
    v_out := v_out || 'pharmacy_store';
  end if;
  return v_out;
end $$;

create or replace function go_live(p_tenant uuid, p_by uuid)
returns text[]
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_blockers text[];
begin
  if not exists (select 1 from tenant_members where id = p_by and tenant_id = p_tenant and membership_role = 'tenant_admin' and is_active) then
    raise exception 'NOT_TENANT_ADMIN' using errcode = 'P0001';
  end if;
  v_blockers := go_live_blockers(p_tenant);
  if array_length(v_blockers, 1) > 0 then return v_blockers; end if;
  update tenants set status = 'active', status_reason = null where id = p_tenant and status = 'pending';
  if found then
    insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome)
    values (p_tenant, 'member', p_by, 'tenant.go_live', 'tenant', p_tenant::text, 'success');
  end if;
  return '{}';
end $$;

-- ── privileges ───────────────────────────────────────────────────────────────
revoke all on function available_slots(uuid, uuid, date, date)                                                    from public, anon, authenticated;
revoke all on function public_clinic_profile(text)                                                                  from public, anon, authenticated;
revoke all on function invite_member(uuid, text, text, text, text, membership_role, uuid[], text, uuid)            from public, anon, authenticated;
revoke all on function reissue_member_invite(uuid, uuid, text, uuid)                                                from public, anon, authenticated;
revoke all on function set_member_roles(uuid, uuid, uuid[], uuid)                                                   from public, anon, authenticated;
revoke all on function set_member_active(uuid, uuid, boolean, uuid)                                                 from public, anon, authenticated;
revoke all on function go_live_blockers(uuid)                                                                       from public, anon, authenticated;
revoke all on function go_live(uuid, uuid)                                                                          from public, anon, authenticated;
grant execute on function available_slots(uuid, uuid, date, date)                                                    to service_role;
grant execute on function public_clinic_profile(text)                                                                  to service_role;
grant execute on function invite_member(uuid, text, text, text, text, membership_role, uuid[], text, uuid)            to service_role;
grant execute on function reissue_member_invite(uuid, uuid, text, uuid)                                                to service_role;
grant execute on function set_member_roles(uuid, uuid, uuid[], uuid)                                                   to service_role;
grant execute on function set_member_active(uuid, uuid, boolean, uuid)                                                 to service_role;
grant execute on function go_live_blockers(uuid)                                                                       to service_role;
grant execute on function go_live(uuid, uuid)                                                                          to service_role;
