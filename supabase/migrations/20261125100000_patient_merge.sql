-- =============================================================================
-- 0057 PATIENT MERGE (M-37, Phase 2): combine two records of the same person, audited and
-- reversible. Every record of the duplicate (appointments, visits, bills, payments, returns,
-- allergies, vitals, consultations, prescriptions, outside prescriptions, care grants) moves
-- to the record that is kept; the duplicate is hidden (deleted_at) and points at the kept
-- record (merged_into). Which rows moved is kept, so "undo" moves exactly those back.
-- Not moved: the accounts journal (ledger_entries, append-only; its patient column is never
-- read by patient) and the audit log (history stays as it happened).
-- Decision D-138.
-- =============================================================================

alter table patients add column merged_into uuid, add column merged_at timestamptz;
alter table patients add constraint patients_merged_into_fk foreign key (tenant_id, merged_into) references patients (tenant_id, id);
alter table patients add constraint patients_merged_hidden check (merged_into is null or (deleted_at is not null and merged_into <> id));
-- The app's column grants (0024) leave merged_into/merged_at to the functions below.

create table patient_merges (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  kept_patient_id    uuid not null,
  merged_patient_id  uuid not null,
  reason             text check (reason is null or length(reason) <= 200),
  kept_was_flagged   boolean not null,
  merged_by          uuid not null,
  merged_at          timestamptz not null default now(),
  undone_by          uuid,
  undone_at          timestamptz,
  unique (tenant_id, id),
  check (kept_patient_id <> merged_patient_id),
  check ((undone_by is null) = (undone_at is null)),
  foreign key (tenant_id, kept_patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, merged_patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, merged_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, undone_by) references tenant_members (tenant_id, id)
);
create index patient_merges_kept on patient_merges (tenant_id, kept_patient_id);
create unique index patient_merges_one_open on patient_merges (tenant_id, merged_patient_id) where undone_at is null;
alter table patient_merges enable row level security;
revoke insert, update, delete on patient_merges from service_role;

-- Exactly which rows moved, so undo moves those back and nothing created since.
create table patient_merge_rows (
  tenant_id  uuid not null,
  merge_id   uuid not null,
  tbl        text not null check (tbl in ('appointments', 'visits', 'invoices', 'payments', 'sale_returns', 'patient_allergies',
                                          'vitals', 'encounters', 'prescriptions', 'external_prescriptions', 'care_access_grants')),
  row_id     uuid not null,
  status_at_merge text,
  primary key (merge_id, tbl, row_id),
  foreign key (tenant_id, merge_id) references patient_merges (tenant_id, id) on delete cascade
);
alter table patient_merge_rows enable row level security;
revoke insert, update, delete on patient_merge_rows from service_role;

-- A row of a locked table (signed consultation, issued prescription, vitals) may change its
-- patient only while it moves between the two records of a merge (either direction), and
-- nothing else on the row may change.
create or replace function patient_merge_move_ok(p_tenant uuid, p_from uuid, p_to uuid)
returns boolean
language sql stable
set search_path = pg_catalog, public
as $$
  select p_from is distinct from p_to and exists (
    select 1 from patients p where p.tenant_id = p_tenant
       and ((p.id = p_from and p.merged_into = p_to) or (p.id = p_to and p.merged_into = p_from)));
$$;

create or replace function only_patient_moved(p_old jsonb, p_new jsonb)
returns boolean
language sql immutable
set search_path = pg_catalog, public
as $$ select (p_old - 'patient_id' - 'updated_at') = (p_new - 'patient_id' - 'updated_at'); $$;

create or replace function encounters_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.patient_id is distinct from old.patient_id and patient_merge_move_ok(old.tenant_id, old.patient_id, new.patient_id)
     and only_patient_moved(to_jsonb(old), to_jsonb(new)) then
    return new;
  end if;
  if old.status = 'finalized' then raise exception 'ENCOUNTER_FINALIZED' using errcode = 'P0001'; end if;
  return new;
end $$;

create or replace function prescriptions_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'draft' then return new; end if;
  if new.patient_id is distinct from old.patient_id and patient_merge_move_ok(old.tenant_id, old.patient_id, new.patient_id)
     and only_patient_moved(to_jsonb(old), to_jsonb(new)) then
    return new;
  end if;
  -- issued → cancelled is the only change allowed, and it touches nothing else.
  if old.status = 'issued' and new.status = 'cancelled'
     and row(new.rx_number, new.notes, new.issued_at, new.patient_id, new.encounter_id, new.doctor_member_id)
         is not distinct from row(old.rx_number, old.notes, old.issued_at, old.patient_id, old.encounter_id, old.doctor_member_id) then
    return new;
  end if;
  raise exception 'PRESCRIPTION_LOCKED' using errcode = 'P0001';
end $$;

create or replace function vitals_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' and new.patient_id is distinct from old.patient_id
     and patient_merge_move_ok(old.tenant_id, old.patient_id, new.patient_id)
     and only_patient_moved(to_jsonb(old), to_jsonb(new)) then
    return new;
  end if;
  raise exception 'APPEND_ONLY' using errcode = 'P0001';
end $$;
revoke all on function vitals_guard() from public, anon, authenticated;
drop trigger vitals_append_only on vitals;
create trigger vitals_append_only before update or delete on vitals for each row execute function vitals_guard();

-- Combine p_merged into p_kept. Needs manage_patients. Refused while the duplicate is in
-- today's queue (a doctor may have its chart open) or when the two have overlapping bookings.
create or replace function merge_patients(p_tenant uuid, p_kept uuid, p_merged uuid, p_by uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_kept patients; v_dup patients; v_merge uuid; v_counts jsonb := '{}'::jsonb; v_n int; t text;
  v_tables text[] := array['appointments', 'visits', 'invoices', 'payments', 'sale_returns', 'patient_allergies',
                           'vitals', 'encounters', 'prescriptions', 'external_prescriptions', 'care_access_grants'];
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_patients') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if p_kept = p_merged then raise exception 'MERGE_SAME_PATIENT' using errcode = 'P0001'; end if;
  -- Lock both in a fixed order so two merges of the same pair can't interleave.
  perform 1 from patients where tenant_id = p_tenant and id in (p_kept, p_merged) order by id for update;
  select * into v_kept from patients where tenant_id = p_tenant and id = p_kept and deleted_at is null;
  select * into v_dup from patients where tenant_id = p_tenant and id = p_merged and deleted_at is null;
  if v_kept.id is null or v_dup.id is null then raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from visits where tenant_id = p_tenant and patient_id = p_merged and status in ('waiting', 'with_doctor', 'awaiting_billing')) then
    raise exception 'MERGE_LIVE_VISIT' using errcode = 'P0001';
  end if;

  insert into patient_merges (tenant_id, kept_patient_id, merged_patient_id, reason, kept_was_flagged, merged_by)
  values (p_tenant, p_kept, p_merged, nullif(btrim(left(p_reason, 200)), ''), v_kept.possible_duplicate, p_by)
  returning id into v_merge;

  -- Point the duplicate at the kept record first: the locked-table triggers check this pair.
  update patients set merged_into = p_kept, merged_at = now(), deleted_at = now() where id = p_merged;

  foreach t in array v_tables loop
    execute format(
      'with m as (update %1$I set patient_id = $2 where tenant_id = $1 and patient_id = $3 returning id%2$s)
       insert into patient_merge_rows (tenant_id, merge_id, tbl, row_id, status_at_merge) select $1, $4, %3$L, id, %4$s from m',
      t, case when t = 'appointments' then ', status' else '' end, t, case when t = 'appointments' then 'status' else 'null' end)
      using p_tenant, p_kept, p_merged, v_merge;
    get diagnostics v_n = row_count;
    if v_n > 0 then v_counts := v_counts || jsonb_build_object(t, v_n); end if;
  end loop;

  -- The kept record stops warning once no other likely match is left.
  update patients set possible_duplicate = false
   where id = p_kept and possible_duplicate and not exists (select 1 from patient_duplicate_candidates(p_tenant, p_kept));

  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, patient_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, 'patient.merged', 'patient', p_kept::text, p_kept, 'success', nullif(btrim(left(p_reason, 200)), ''),
          jsonb_build_object('merge_id', v_merge, 'merged_patient_id', p_merged, 'merged_mrn', v_dup.mrn, 'kept_mrn', v_kept.mrn, 'moved', v_counts));
  return v_merge;
exception
  when exclusion_violation then raise exception 'MERGE_APPOINTMENT_CLASH' using errcode = 'P0001';
  when unique_violation then raise exception 'MERGE_LIVE_VISIT' using errcode = 'P0001';
end $$;

-- Undo a merge: the rows that moved go back, the duplicate reappears. Anything created on the
-- kept record since stays there. An appointment whose status changed since the merge (for
-- example checked in under the kept record) stays too, so it stays with the visit it made.
create or replace function undo_patient_merge(p_tenant uuid, p_merge uuid, p_by uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  m patient_merges; v_counts jsonb := '{}'::jsonb; v_kept_back int := 0; v_n int; t text;
  v_tables text[] := array['appointments', 'visits', 'invoices', 'payments', 'sale_returns', 'patient_allergies',
                           'vitals', 'encounters', 'prescriptions', 'external_prescriptions', 'care_access_grants'];
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_patients') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  select * into m from patient_merges where tenant_id = p_tenant and id = p_merge for update;
  if m.id is null then raise exception 'MERGE_NOT_FOUND' using errcode = 'P0001'; end if;
  if m.undone_at is not null then raise exception 'MERGE_ALREADY_UNDONE' using errcode = 'P0001'; end if;
  perform 1 from patients where tenant_id = p_tenant and id in (m.kept_patient_id, m.merged_patient_id) order by id for update;
  -- The kept record was itself merged into a third one since: undo that merge first.
  if not exists (select 1 from patients where id = m.kept_patient_id and deleted_at is null) then
    raise exception 'MERGE_UNDO_LATER_FIRST' using errcode = 'P0001';
  end if;
  if exists (select 1 from patient_merge_rows r join visits v on v.id = r.row_id
              where r.merge_id = m.id and r.tbl = 'visits' and v.status in ('waiting', 'with_doctor', 'awaiting_billing')) then
    raise exception 'MERGE_LIVE_VISIT' using errcode = 'P0001';
  end if;

  foreach t in array v_tables loop
    execute format(
      'update %1$I x set patient_id = $3 from patient_merge_rows r
        where r.tenant_id = $1 and r.merge_id = $4 and r.tbl = %2$L and r.row_id = x.id and x.tenant_id = $1 and x.patient_id = $2%3$s',
      t, t, case when t = 'appointments' then ' and x.status = r.status_at_merge' else '' end)
      using p_tenant, m.kept_patient_id, m.merged_patient_id, m.id;
    get diagnostics v_n = row_count;
    if v_n > 0 then v_counts := v_counts || jsonb_build_object(t, v_n); end if;
  end loop;
  select count(*) into v_kept_back from patient_merge_rows r join appointments a on a.id = r.row_id
   where r.merge_id = m.id and r.tbl = 'appointments' and a.patient_id = m.kept_patient_id;

  update patients set merged_into = null, merged_at = null, deleted_at = null where id = m.merged_patient_id;
  update patients set possible_duplicate = true where id = m.kept_patient_id and m.kept_was_flagged;
  update patient_merges set undone_by = p_by, undone_at = now() where id = m.id;

  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, patient_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, 'patient.merge_undone', 'patient', m.kept_patient_id::text, m.kept_patient_id, 'success', nullif(btrim(left(p_reason, 200)), ''),
          jsonb_build_object('merge_id', m.id, 'merged_patient_id', m.merged_patient_id, 'moved_back', v_counts, 'appointments_kept', v_kept_back));
  return jsonb_build_object('moved_back', v_counts, 'appointments_kept', v_kept_back);
exception
  when exclusion_violation then raise exception 'MERGE_APPOINTMENT_CLASH' using errcode = 'P0001';
  when unique_violation then raise exception 'MERGE_LIVE_VISIT' using errcode = 'P0001';
end $$;

-- A printed card with the old MRN still finds the person: searching a merged record's MRN
-- returns the record it was merged into.
create or replace function search_patients(p_tenant uuid, p_q text, p_limit integer default 20)
returns setof patients
language sql stable
set search_path = pg_catalog, public
as $$
  with q as (select btrim(coalesce(p_q, '')) t, regexp_replace(coalesce(p_q, ''), '\D', '', 'g') d)
  select p.* from patients p, q
   where p.tenant_id = p_tenant and p.deleted_at is null
     and ((q.d = q.t and length(q.d) between 1 and 6
           and (p.mrn = lpad(q.d, 6, '0')
                or exists (select 1 from patients o where o.tenant_id = p_tenant and o.merged_into = p.id and o.mrn = lpad(q.d, 6, '0'))))
          or (length(q.d) >= 4 and q.d = regexp_replace(q.t, '[\s+()-]', '', 'g') and p.phone_digits like '%' || q.d || '%')
          or (length(q.t) >= 2 and lower(p.full_name) like '%' || lower(q.t) || '%'))
   order by (p.mrn = lpad(q.d, 6, '0')) desc, p.full_name
   limit least(greatest(p_limit, 1), 50);
$$;

revoke all on function merge_patients(uuid, uuid, uuid, uuid, text), undo_patient_merge(uuid, uuid, uuid, text),
                       patient_merge_move_ok(uuid, uuid, uuid), only_patient_moved(jsonb, jsonb) from public, anon, authenticated;
grant execute on function merge_patients(uuid, uuid, uuid, uuid, text), undo_patient_merge(uuid, uuid, uuid, text),
                           patient_merge_move_ok(uuid, uuid, uuid), only_patient_moved(jsonb, jsonb) to service_role;
