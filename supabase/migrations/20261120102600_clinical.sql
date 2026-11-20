-- =============================================================================
-- 0027 CLINICAL (B4b): encounters (draft → finalized, then addenda only), vitals, diagnoses,
-- prescriptions (draft → issued → cancelled, immutable once issued), care access grants
-- (referral / share / break-glass), and the CARE PREDICATE (permissions.md §6).
-- database.md §7; security.md §4 (clinical RPCs + audited reads); decisions D-06, D-52.
--
-- Stronger than security.md's "SECURITY INVOKER clinical RPCs": the app role (service_role)
-- holds NO privilege on clinical tables at all. Every read and write goes through the
-- SECURITY DEFINER functions below, which evaluate the care predicate, refuse PIN sessions
-- (A1) and write the audit row in the same transaction, so a bug in a page can't leak a chart.
-- =============================================================================

create table care_access_grants (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete restrict,
  member_id   uuid not null,
  patient_id  uuid not null,
  kind        text not null check (kind in ('referral', 'share', 'break_glass')),
  reason      text not null check (length(btrim(reason)) >= 5),
  granted_by  uuid not null,
  starts_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid,
  unique (tenant_id, id),
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, granted_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, reviewed_by) references tenant_members (tenant_id, id),
  check (expires_at > starts_at)
);
create index care_access_grants_lookup on care_access_grants (tenant_id, member_id, patient_id, expires_at);

create table encounters (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete restrict,
  patient_id        uuid not null,
  doctor_member_id  uuid not null,
  visit_id          uuid unique,
  status            text not null default 'draft' check (status in ('draft', 'finalized')),
  chief_complaint   text check (length(chief_complaint) <= 2000),
  history           text check (length(history) <= 8000),
  examination       text check (length(examination) <= 8000),
  assessment        text check (length(assessment) <= 4000),
  plan              text check (length(plan) <= 4000),
  advice            text check (length(advice) <= 4000),
  follow_up_on      date,
  started_at        timestamptz not null default now(),
  finalized_at      timestamptz,
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, doctor_member_id) references tenant_members (tenant_id, id),
  foreign key (tenant_id, visit_id) references visits (tenant_id, id),
  check ((status = 'finalized') = (finalized_at is not null))
);
create index encounters_patient on encounters (tenant_id, patient_id, started_at desc);
create trigger encounters_touch before update on encounters for each row execute function touch_updated_at();

create table encounter_addenda (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  encounter_id  uuid not null,
  author_id     uuid not null,
  body          text not null check (length(btrim(body)) between 2 and 4000),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, encounter_id) references encounters (tenant_id, id),
  foreign key (tenant_id, author_id) references tenant_members (tenant_id, id)
);

create table diagnoses (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  encounter_id  uuid not null,
  text          text not null check (length(btrim(text)) between 2 and 200),
  icd10         text check (icd10 ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$'),
  is_primary    boolean not null default false,
  sort_order    smallint not null default 0,
  unique (tenant_id, id),
  foreign key (tenant_id, encounter_id) references encounters (tenant_id, id)
);

create table vitals (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  patient_id    uuid not null,
  visit_id      uuid,
  recorded_by   uuid not null,
  recorded_at   timestamptz not null default now(),
  systolic      smallint check (systolic between 50 and 260),
  diastolic     smallint check (diastolic between 30 and 160),
  pulse         smallint check (pulse between 20 and 250),
  temp_c        numeric(4,1) check (temp_c between 30 and 45),
  spo2          smallint check (spo2 between 50 and 100),
  resp_rate     smallint check (resp_rate between 5 and 80),
  weight_kg     numeric(5,2) check (weight_kg between 0.3 and 400),
  height_cm     numeric(5,1) check (height_cm between 30 and 250),
  unique (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, visit_id) references visits (tenant_id, id),
  foreign key (tenant_id, recorded_by) references tenant_members (tenant_id, id),
  check ((systolic is null) = (diastolic is null)),
  check (systolic is null or systolic > diastolic),
  check (coalesce(systolic, pulse, spo2, resp_rate)::numeric is not null or coalesce(temp_c, weight_kg, height_cm) is not null)
);
create index vitals_patient on vitals (tenant_id, patient_id, recorded_at desc);

create table prescription_counters (
  tenant_id  uuid primary key references tenants (id) on delete restrict,
  next_no    bigint not null default 1
);

create table prescriptions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete restrict,
  patient_id        uuid not null,
  encounter_id      uuid not null unique,
  doctor_member_id  uuid not null,
  rx_number         text,
  status            text not null default 'draft' check (status in ('draft', 'issued', 'cancelled')),
  notes             text check (length(notes) <= 1000),
  issued_at         timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,
  created_at        timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, rx_number),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, encounter_id) references encounters (tenant_id, id),
  foreign key (tenant_id, doctor_member_id) references tenant_members (tenant_id, id),
  check ((status = 'draft') = (rx_number is null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

create table prescription_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  prescription_id  uuid not null,
  line_no          smallint not null check (line_no between 1 and 40),
  item_id          uuid,          -- → inventory items (B5); the printed name is medicine_text
  medicine_text    text not null check (length(btrim(medicine_text)) between 2 and 120),
  strength         text check (length(strength) <= 40),
  form             text check (length(form) <= 30),
  dose             text check (length(dose) <= 40),
  frequency        text check (length(frequency) <= 60),
  route            text check (length(route) <= 30),
  duration_days    smallint check (duration_days between 1 and 365),
  quantity         numeric(8,2) check (quantity > 0),
  instructions     text check (length(instructions) <= 300),
  unique (tenant_id, id),
  unique (prescription_id, line_no),
  foreign key (tenant_id, prescription_id) references prescriptions (tenant_id, id) on delete cascade
);

-- Finalized notes and issued prescriptions never change (addenda / cancel instead).
create or replace function clinical_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'encounters' and old.status = 'finalized' then
    raise exception 'ENCOUNTER_FINALIZED' using errcode = 'P0001';
  end if;
  if tg_table_name = 'prescriptions' and old.status <> 'draft'
     and not (old.status = 'issued' and new.status = 'cancelled'
              and row(new.rx_number, new.notes, new.issued_at, new.patient_id, new.encounter_id)
                  is not distinct from row(old.rx_number, old.notes, old.issued_at, old.patient_id, old.encounter_id)) then
    raise exception 'PRESCRIPTION_LOCKED' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger encounters_immutable before update on encounters for each row execute function clinical_immutable();
create trigger prescriptions_immutable before update on prescriptions for each row execute function clinical_immutable();
create or replace function rx_items_locked()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_status text;
begin
  select status into v_status from prescriptions where id = coalesce(new.prescription_id, old.prescription_id);
  if v_status is distinct from 'draft' and v_status is not null then
    raise exception 'PRESCRIPTION_LOCKED' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger prescription_items_locked before insert or update or delete on prescription_items for each row execute function rx_items_locked();
create or replace function encounter_children_locked()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if exists (select 1 from encounters where id = coalesce(new.encounter_id, old.encounter_id) and status = 'finalized') then
    raise exception 'ENCOUNTER_FINALIZED' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger diagnoses_locked before insert or update or delete on diagnoses for each row execute function encounter_children_locked();
create or replace function forbid_change()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin raise exception 'APPEND_ONLY' using errcode = 'P0001'; end $$;
create trigger encounter_addenda_append_only before update or delete on encounter_addenda for each row execute function forbid_change();
create trigger vitals_append_only before update or delete on vitals for each row execute function forbid_change();

-- ── access: nothing for the app role; functions only ──────────────────────────
alter table care_access_grants     enable row level security;
alter table encounters             enable row level security;
alter table encounter_addenda      enable row level security;
alter table diagnoses              enable row level security;
alter table vitals                 enable row level security;
alter table prescription_counters  enable row level security;
alter table prescriptions          enable row level security;
alter table prescription_items     enable row level security;
revoke all on care_access_grants, encounters, encounter_addenda, diagnoses, vitals, prescription_counters,
              prescriptions, prescription_items from service_role;
-- Allergies are clinical too (permissions.md §6): reads and writes move behind the functions.
revoke all on patient_allergies from service_role;

-- =============================================================================
-- THE CARE PREDICATE (permissions.md §6). Returns the member's scope for the patient:
--   'write'  C1: the doctor on today's/upcoming visit or appointment (with write_consultation)
--   'read'   C1 without write key, C2 past encounter, C4 grant, C5 view_all_clinical, C6 break-glass
--   'vitals' C3: patient has an open visit today and the member holds record_vitals
--   null     no access
-- Clinical keys only reach members with a verified credential (effective_permissions, D-06).
-- =============================================================================
create or replace function clinical_scope(p_tenant uuid, p_member uuid, p_patient uuid)
returns text
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_perm text[]; v_today date; v_care boolean;
begin
  if not exists (select 1 from tenant_members where id = p_member and tenant_id = p_tenant and is_active and deleted_at is null) then return null; end if;
  if not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant and deleted_at is null) then return null; end if;
  v_perm := effective_permissions(p_member);
  select (now() at time zone timezone)::date into v_today from tenants where id = p_tenant;
  v_care := exists (select 1 from visits where tenant_id = p_tenant and patient_id = p_patient and doctor_member_id = p_member
                      and visit_date >= v_today and status <> 'cancelled')
         or exists (select 1 from appointments where tenant_id = p_tenant and patient_id = p_patient and doctor_member_id = p_member
                      and appointment_date >= v_today and status not in ('cancelled', 'no_show'));
  if v_care and 'write_consultation' = any (v_perm) then return 'write'; end if;
  if 'view_clinical' = any (v_perm) and (v_care
       or exists (select 1 from encounters where tenant_id = p_tenant and patient_id = p_patient and doctor_member_id = p_member)
       or exists (select 1 from care_access_grants where tenant_id = p_tenant and member_id = p_member and patient_id = p_patient
                    and kind in ('referral', 'share') and revoked_at is null and now() between starts_at and expires_at)) then
    return 'read';
  end if;
  if 'view_all_clinical' = any (v_perm) then return 'read'; end if;
  if exists (select 1 from care_access_grants where tenant_id = p_tenant and member_id = p_member and patient_id = p_patient
               and kind = 'break_glass' and revoked_at is null and now() between starts_at and expires_at) then
    return 'read';
  end if;
  if 'record_vitals' = any (v_perm) and exists (select 1 from visits where tenant_id = p_tenant and patient_id = p_patient
       and visit_date = v_today and status in ('waiting', 'with_doctor')) then
    return 'vitals';
  end if;
  return null;
end $$;

-- Shared guard for every clinical function: PIN sessions never reach records (A1 ceiling).
create or replace function clinical_guard(p_tenant uuid, p_member uuid, p_patient uuid, p_session_level text, p_need text, p_action text)
returns text
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_scope text := clinical_scope(p_tenant, p_member, p_patient);
begin
  if p_session_level is null or p_session_level not in ('A2', 'A3') then
    insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason)
    values (p_tenant, 'member', p_member, p_session_level, p_action, 'patient', p_patient::text, 'denied', 'assurance');
    raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001';
  end if;
  if v_scope is null
     or (p_need = 'write' and v_scope <> 'write')
     or (p_need = 'read' and v_scope not in ('write', 'read'))
     or (p_need = 'vitals' and v_scope not in ('write', 'vitals')) then
    insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason)
    values (p_tenant, 'member', p_member, p_session_level, p_action, 'patient', p_patient::text, 'denied', coalesce(v_scope, 'no_care_relationship'));
    raise exception 'NO_CLINICAL_ACCESS' using errcode = 'P0001';
  end if;
  return v_scope;
end $$;

-- ── read: the chart (audited) ─────────────────────────────────────────────────
create or replace function open_chart(p_tenant uuid, p_member uuid, p_patient uuid, p_session_level text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_scope text; v_out jsonb;
begin
  v_scope := clinical_scope(p_tenant, p_member, p_patient);
  perform clinical_guard(p_tenant, p_member, p_patient, p_session_level, case when v_scope = 'vitals' then 'vitals' else 'read' end, 'patient.chart_read');
  v_out := jsonb_build_object(
    'scope', v_scope,
    'patient', (select jsonb_build_object('id', id, 'mrn', mrn, 'full_name', full_name, 'sex', sex, 'date_of_birth', date_of_birth,
                  'age_years', age_years, 'created_at', created_at, 'blood_group', blood_group, 'phone', phone) from patients where id = p_patient),
    'allergies', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'allergen', allergen, 'reaction', reaction, 'severity', severity) order by created_at)
                   from patient_allergies where tenant_id = p_tenant and patient_id = p_patient and removed_at is null), '[]'),
    'vitals', coalesce((select jsonb_agg(v order by v->>'recorded_at' desc) from (
                   select jsonb_build_object('recorded_at', recorded_at, 'systolic', systolic, 'diastolic', diastolic, 'pulse', pulse, 'temp_c', temp_c,
                     'spo2', spo2, 'resp_rate', resp_rate, 'weight_kg', weight_kg, 'height_cm', height_cm) v
                     from vitals where tenant_id = p_tenant and patient_id = p_patient
                      and (v_scope <> 'vitals' or recorded_at > now() - interval '1 day')
                     order by recorded_at desc limit 10) x), '[]'));
  if v_scope in ('write', 'read') then
    v_out := v_out || jsonb_build_object(
      'encounters', coalesce((select jsonb_agg(e order by e->>'started_at' desc) from (
          select jsonb_build_object('id', en.id, 'status', en.status, 'started_at', en.started_at, 'finalized_at', en.finalized_at,
                   'doctor', m.display_name, 'mine', en.doctor_member_id = p_member, 'visit_id', en.visit_id,
                   'chief_complaint', en.chief_complaint, 'history', en.history, 'examination', en.examination, 'assessment', en.assessment,
                   'plan', en.plan, 'advice', en.advice, 'follow_up_on', en.follow_up_on,
                   'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('text', d.text, 'icd10', d.icd10, 'is_primary', d.is_primary) order by d.sort_order)
                                 from diagnoses d where d.encounter_id = en.id), '[]'),
                   'addenda', coalesce((select jsonb_agg(jsonb_build_object('body', a.body, 'at', a.created_at, 'by', am.display_name) order by a.created_at)
                                 from encounter_addenda a join tenant_members am on am.id = a.author_id where a.encounter_id = en.id), '[]'),
                   'prescription', (select jsonb_build_object('id', rx.id, 'rx_number', rx.rx_number, 'status', rx.status, 'notes', rx.notes, 'issued_at', rx.issued_at,
                                      'items', coalesce((select jsonb_agg(jsonb_build_object('medicine_text', i.medicine_text, 'strength', i.strength, 'form', i.form,
                                          'dose', i.dose, 'frequency', i.frequency, 'route', i.route, 'duration_days', i.duration_days, 'quantity', i.quantity,
                                          'instructions', i.instructions) order by i.line_no) from prescription_items i where i.prescription_id = rx.id), '[]'))
                                    from prescriptions rx where rx.encounter_id = en.id)) e
            from encounters en join tenant_members m on m.id = en.doctor_member_id
           where en.tenant_id = p_tenant and en.patient_id = p_patient
             and (en.status = 'finalized' or en.doctor_member_id = p_member)   -- others' drafts stay private
           order by en.started_at desc limit 30) x), '[]'));
  end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_member, p_session_level, 'patient.chart_read', 'patient', p_patient::text, 'success', jsonb_build_object('scope', v_scope));
  return v_out;
end $$;

-- ── write: encounter ──────────────────────────────────────────────────────────
-- The doctor opens (or reopens) the draft for their visit.
create or replace function start_encounter(p_tenant uuid, p_member uuid, p_visit uuid, p_session_level text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v visits; v_id uuid;
begin
  select * into v from visits where id = p_visit and tenant_id = p_tenant;
  if v.id is null then raise exception 'VISIT_NOT_FOUND' using errcode = 'P0001'; end if;
  perform clinical_guard(p_tenant, p_member, v.patient_id, p_session_level, 'write', 'encounter.start');
  if v.doctor_member_id <> p_member then raise exception 'NOT_YOUR_VISIT' using errcode = 'P0001'; end if;
  if v.status = 'cancelled' then raise exception 'VISIT_CANCELLED' using errcode = 'P0001'; end if;
  select id into v_id from encounters where visit_id = p_visit;
  if v_id is null then
    insert into encounters (tenant_id, patient_id, doctor_member_id, visit_id) values (p_tenant, v.patient_id, p_member, p_visit) returning id into v_id;
    insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome)
    values (p_tenant, 'member', p_member, p_session_level, 'encounter.start', 'encounter', v_id::text, 'success');
  end if;
  return v_id;
end $$;

-- Save the draft: note fields and the diagnosis list (replaced as a whole).
create or replace function save_encounter(p_tenant uuid, p_member uuid, p_encounter uuid, p_note jsonb, p_diagnoses jsonb, p_session_level text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare e encounters;
begin
  select * into e from encounters where id = p_encounter and tenant_id = p_tenant for update;
  if e.id is null then raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0001'; end if;
  perform clinical_guard(p_tenant, p_member, e.patient_id, p_session_level, 'write', 'encounter.save');
  if e.doctor_member_id <> p_member then raise exception 'NOT_YOUR_ENCOUNTER' using errcode = 'P0001'; end if;
  if e.status <> 'draft' then raise exception 'ENCOUNTER_FINALIZED' using errcode = 'P0001'; end if;
  update encounters set
    chief_complaint = nullif(btrim(p_note->>'chief_complaint'), ''), history = nullif(btrim(p_note->>'history'), ''),
    examination = nullif(btrim(p_note->>'examination'), ''), assessment = nullif(btrim(p_note->>'assessment'), ''),
    plan = nullif(btrim(p_note->>'plan'), ''), advice = nullif(btrim(p_note->>'advice'), ''),
    follow_up_on = nullif(p_note->>'follow_up_on', '')::date
  where id = p_encounter;
  if p_diagnoses is not null then
    delete from diagnoses where encounter_id = p_encounter;
    insert into diagnoses (tenant_id, encounter_id, text, icd10, is_primary, sort_order)
    select p_tenant, p_encounter, btrim(d->>'text'), nullif(upper(btrim(d->>'icd10')), ''), coalesce((d->>'is_primary')::boolean, ord = 1), ord
      from jsonb_array_elements(p_diagnoses) with ordinality as t(d, ord)
     where coalesce(btrim(d->>'text'), '') <> '';
  end if;
end $$;

create or replace function finalize_encounter(p_tenant uuid, p_member uuid, p_encounter uuid, p_session_level text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare e encounters;
begin
  select * into e from encounters where id = p_encounter and tenant_id = p_tenant for update;
  if e.id is null then raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0001'; end if;
  perform clinical_guard(p_tenant, p_member, e.patient_id, p_session_level, 'write', 'encounter.finalize');
  if e.doctor_member_id <> p_member then raise exception 'NOT_YOUR_ENCOUNTER' using errcode = 'P0001'; end if;
  if e.status <> 'draft' then raise exception 'ENCOUNTER_FINALIZED' using errcode = 'P0001'; end if;
  if coalesce(e.chief_complaint, e.assessment) is null and not exists (select 1 from diagnoses where encounter_id = p_encounter) then
    raise exception 'ENCOUNTER_EMPTY' using errcode = 'P0001';
  end if;
  if exists (select 1 from prescriptions where encounter_id = p_encounter and status = 'draft') then
    raise exception 'PRESCRIPTION_NOT_ISSUED' using errcode = 'P0001';
  end if;
  update encounters set status = 'finalized', finalized_at = now() where id = p_encounter;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome)
  values (p_tenant, 'member', p_member, p_session_level, 'encounter.finalize', 'encounter', p_encounter::text, 'success');
end $$;

-- After finalizing, the author corrects or adds by addendum only.
create or replace function add_addendum(p_tenant uuid, p_member uuid, p_encounter uuid, p_body text, p_session_level text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare e encounters;
begin
  select * into e from encounters where id = p_encounter and tenant_id = p_tenant;
  if e.id is null then raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0001'; end if;
  perform clinical_guard(p_tenant, p_member, e.patient_id, p_session_level, 'read', 'encounter.addendum');
  if e.doctor_member_id <> p_member then raise exception 'NOT_YOUR_ENCOUNTER' using errcode = 'P0001'; end if;
  if e.status <> 'finalized' then raise exception 'ENCOUNTER_NOT_FINALIZED' using errcode = 'P0001'; end if;
  if not ('write_consultation' = any (effective_permissions(p_member))) then raise exception 'NO_CLINICAL_ACCESS' using errcode = 'P0001'; end if;
  insert into encounter_addenda (tenant_id, encounter_id, author_id, body) values (p_tenant, p_encounter, p_member, btrim(p_body));
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome)
  values (p_tenant, 'member', p_member, p_session_level, 'encounter.addendum', 'encounter', p_encounter::text, 'success');
end $$;

-- ── write: vitals and allergies (doctor, or nurse/registrar with record_vitals on today's visit) ──
create or replace function record_vitals(p_tenant uuid, p_member uuid, p_patient uuid, p_visit uuid, p_v jsonb, p_session_level text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid; v_scope text;
begin
  v_scope := clinical_scope(p_tenant, p_member, p_patient);
  perform clinical_guard(p_tenant, p_member, p_patient, p_session_level, 'vitals', 'vitals.record');
  if v_scope = 'write' and not ('record_vitals' = any (effective_permissions(p_member)) or 'write_consultation' = any (effective_permissions(p_member))) then
    raise exception 'NO_CLINICAL_ACCESS' using errcode = 'P0001';
  end if;
  if p_visit is not null and not exists (select 1 from visits where id = p_visit and tenant_id = p_tenant and patient_id = p_patient) then
    raise exception 'VISIT_NOT_FOUND' using errcode = 'P0001';
  end if;
  insert into vitals (tenant_id, patient_id, visit_id, recorded_by, systolic, diastolic, pulse, temp_c, spo2, resp_rate, weight_kg, height_cm)
  values (p_tenant, p_patient, p_visit, p_member, (p_v->>'systolic')::smallint, (p_v->>'diastolic')::smallint, (p_v->>'pulse')::smallint,
          (p_v->>'temp_c')::numeric, (p_v->>'spo2')::smallint, (p_v->>'resp_rate')::smallint, (p_v->>'weight_kg')::numeric, (p_v->>'height_cm')::numeric)
  returning id into v_id;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome)
  values (p_tenant, 'member', p_member, p_session_level, 'vitals.record', 'patient', p_patient::text, 'success');
  return v_id;
end $$;

create or replace function set_allergy(p_tenant uuid, p_member uuid, p_patient uuid, p_allergy uuid, p_allergen text, p_reaction text,
                                       p_severity text, p_remove boolean, p_session_level text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  perform clinical_guard(p_tenant, p_member, p_patient, p_session_level, 'vitals', 'allergy.change');
  if p_remove then
    update patient_allergies set removed_at = now() where id = p_allergy and tenant_id = p_tenant and patient_id = p_patient and removed_at is null;
    if not found then raise exception 'ALLERGY_NOT_FOUND' using errcode = 'P0001'; end if;
  else
    insert into patient_allergies (tenant_id, patient_id, allergen, reaction, severity, recorded_by)
    values (p_tenant, p_patient, btrim(p_allergen), nullif(btrim(p_reaction), ''), nullif(p_severity, ''), p_member);
  end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_member, p_session_level, case when p_remove then 'allergy.remove' else 'allergy.add' end, 'patient', p_patient::text,
          'success', jsonb_build_object('allergen', case when p_remove then null else btrim(p_allergen) end));
end $$;

-- ── write: prescription ───────────────────────────────────────────────────────
-- Replace the draft prescription's items for an encounter (created on first save).
create or replace function save_prescription(p_tenant uuid, p_member uuid, p_encounter uuid, p_items jsonb, p_notes text, p_session_level text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare e encounters; v_rx prescriptions;
begin
  select * into e from encounters where id = p_encounter and tenant_id = p_tenant;
  if e.id is null then raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0001'; end if;
  perform clinical_guard(p_tenant, p_member, e.patient_id, p_session_level, 'write', 'prescription.save');
  if e.doctor_member_id <> p_member then raise exception 'NOT_YOUR_ENCOUNTER' using errcode = 'P0001'; end if;
  if e.status <> 'draft' then raise exception 'ENCOUNTER_FINALIZED' using errcode = 'P0001'; end if;
  if not ('issue_prescriptions' = any (effective_permissions(p_member))) then raise exception 'NO_PRESCRIBING_RIGHT' using errcode = 'P0001'; end if;
  select * into v_rx from prescriptions where encounter_id = p_encounter for update;
  if v_rx.id is null then
    insert into prescriptions (tenant_id, patient_id, encounter_id, doctor_member_id, notes)
    values (p_tenant, e.patient_id, p_encounter, p_member, nullif(btrim(p_notes), '')) returning * into v_rx;
  elsif v_rx.status <> 'draft' then
    raise exception 'PRESCRIPTION_LOCKED' using errcode = 'P0001';
  else
    update prescriptions set notes = nullif(btrim(p_notes), '') where id = v_rx.id;
  end if;
  delete from prescription_items where prescription_id = v_rx.id;
  insert into prescription_items (tenant_id, prescription_id, line_no, medicine_text, strength, form, dose, frequency, route,
                                  duration_days, quantity, instructions)
  select p_tenant, v_rx.id, ord, btrim(i->>'medicine_text'), nullif(btrim(i->>'strength'), ''), nullif(btrim(i->>'form'), ''),
         nullif(btrim(i->>'dose'), ''), nullif(btrim(i->>'frequency'), ''), nullif(btrim(i->>'route'), ''),
         nullif(i->>'duration_days', '')::smallint, nullif(i->>'quantity', '')::numeric, nullif(btrim(i->>'instructions'), '')
    from jsonb_array_elements(coalesce(p_items, '[]')) with ordinality as t(i, ord)
   where coalesce(btrim(i->>'medicine_text'), '') <> '';
  return v_rx.id;
end $$;

create or replace function issue_prescription(p_tenant uuid, p_member uuid, p_prescription uuid, p_session_level text)
returns text
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_rx prescriptions; v_no bigint; v_number text;
begin
  select * into v_rx from prescriptions where id = p_prescription and tenant_id = p_tenant for update;
  if v_rx.id is null then raise exception 'PRESCRIPTION_NOT_FOUND' using errcode = 'P0001'; end if;
  perform clinical_guard(p_tenant, p_member, v_rx.patient_id, p_session_level, 'write', 'prescription.issue');
  if v_rx.doctor_member_id <> p_member then raise exception 'NOT_YOUR_ENCOUNTER' using errcode = 'P0001'; end if;
  if not ('issue_prescriptions' = any (effective_permissions(p_member))) then raise exception 'NO_PRESCRIBING_RIGHT' using errcode = 'P0001'; end if;
  if v_rx.status <> 'draft' then raise exception 'PRESCRIPTION_LOCKED' using errcode = 'P0001'; end if;
  if not exists (select 1 from prescription_items where prescription_id = p_prescription) then raise exception 'PRESCRIPTION_EMPTY' using errcode = 'P0001'; end if;
  insert into prescription_counters as c (tenant_id, next_no) values (p_tenant, 2)
  on conflict (tenant_id) do update set next_no = c.next_no + 1 returning next_no - 1 into v_no;
  v_number := 'RX-' || lpad(v_no::text, 6, '0');
  update prescriptions set status = 'issued', rx_number = v_number, issued_at = now() where id = p_prescription;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_member, p_session_level, 'prescription.issue', 'prescription', p_prescription::text, 'success', jsonb_build_object('rx_number', v_number));
  return v_number;
end $$;

create or replace function cancel_prescription(p_tenant uuid, p_member uuid, p_prescription uuid, p_reason text, p_session_level text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_rx prescriptions;
begin
  select * into v_rx from prescriptions where id = p_prescription and tenant_id = p_tenant for update;
  if v_rx.id is null then raise exception 'PRESCRIPTION_NOT_FOUND' using errcode = 'P0001'; end if;
  perform clinical_guard(p_tenant, p_member, v_rx.patient_id, p_session_level, 'read', 'prescription.cancel');
  if v_rx.doctor_member_id <> p_member then raise exception 'NOT_YOUR_ENCOUNTER' using errcode = 'P0001'; end if;
  if v_rx.status <> 'issued' then raise exception 'PRESCRIPTION_NOT_ISSUED' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  update prescriptions set status = 'cancelled', cancelled_at = now(), cancel_reason = btrim(p_reason) where id = p_prescription;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason)
  values (p_tenant, 'member', p_member, p_session_level, 'prescription.cancel', 'prescription', p_prescription::text, 'success', btrim(p_reason));
end $$;

-- ── break-glass (permissions.md §7): 60-minute read with a reason; admins review it ──
create or replace function break_glass(p_tenant uuid, p_member uuid, p_patient uuid, p_reason text, p_session_level text, p_reauth_at timestamptz)
returns timestamptz
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_until timestamptz := now() + interval '60 minutes';
begin
  if not ('break_glass' = any (effective_permissions(p_member))) then raise exception 'NO_BREAK_GLASS_RIGHT' using errcode = 'P0001'; end if;
  if p_session_level not in ('A2', 'A3') or p_reauth_at is null or p_reauth_at < now() - interval '5 minutes' then
    raise exception 'REAUTH_REQUIRED' using errcode = 'P0001';
  end if;
  if coalesce(length(btrim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant and deleted_at is null) then raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001'; end if;
  insert into care_access_grants (tenant_id, member_id, patient_id, kind, reason, granted_by, expires_at)
  values (p_tenant, p_member, p_patient, 'break_glass', btrim(p_reason), p_member, v_until);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason)
  values (p_tenant, 'member', p_member, p_session_level, 'clinical.break_glass', 'patient', p_patient::text, 'success', btrim(p_reason));
  return v_until;
end $$;

-- ── privileges ───────────────────────────────────────────────────────────────
revoke all on function clinical_immutable() from public, anon, authenticated, service_role;
revoke all on function rx_items_locked() from public, anon, authenticated, service_role;
revoke all on function encounter_children_locked() from public, anon, authenticated, service_role;
revoke all on function forbid_change() from public, anon, authenticated, service_role;
revoke all on function clinical_guard(uuid, uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function clinical_scope(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function open_chart(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function start_encounter(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function save_encounter(uuid, uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function finalize_encounter(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function add_addendum(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function record_vitals(uuid, uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function set_allergy(uuid, uuid, uuid, uuid, text, text, text, boolean, text) from public, anon, authenticated;
revoke all on function save_prescription(uuid, uuid, uuid, jsonb, text, text) from public, anon, authenticated;
revoke all on function issue_prescription(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function cancel_prescription(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function break_glass(uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function clinical_scope(uuid, uuid, uuid) to service_role;
grant execute on function open_chart(uuid, uuid, uuid, text) to service_role;
grant execute on function start_encounter(uuid, uuid, uuid, text) to service_role;
grant execute on function save_encounter(uuid, uuid, uuid, jsonb, jsonb, text) to service_role;
grant execute on function finalize_encounter(uuid, uuid, uuid, text) to service_role;
grant execute on function add_addendum(uuid, uuid, uuid, text, text) to service_role;
grant execute on function record_vitals(uuid, uuid, uuid, uuid, jsonb, text) to service_role;
grant execute on function set_allergy(uuid, uuid, uuid, uuid, text, text, text, boolean, text) to service_role;
grant execute on function save_prescription(uuid, uuid, uuid, jsonb, text, text) to service_role;
grant execute on function issue_prescription(uuid, uuid, uuid, text) to service_role;
grant execute on function cancel_prescription(uuid, uuid, uuid, text, text) to service_role;
grant execute on function break_glass(uuid, uuid, uuid, text, text, timestamptz) to service_role;
