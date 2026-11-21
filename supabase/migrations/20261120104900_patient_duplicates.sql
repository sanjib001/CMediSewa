-- =============================================================================
-- 0050 PATIENT DUPLICATES (U3b): show a flagged patient's likely matches (the same rule that
-- set the flag) and let the desk clear the flag once it has checked they are different
-- people. Merging two records stays a later feature (M-37, P2: audited and reversible).
-- Decision D-120.
-- =============================================================================

create or replace function patient_duplicate_candidates(p_tenant uuid, p_patient uuid)
returns table (id uuid, mrn text, full_name text, sex text, date_of_birth date, age_years smallint, phone text, created_at timestamptz, why text)
language sql stable
set search_path = pg_catalog, public
as $$
  select o.id, o.mrn, o.full_name, o.sex, o.date_of_birth, o.age_years, o.phone, o.created_at,
         case when p.phone_digits is not null and o.phone_digits = p.phone_digits then 'same phone and first name' else 'same name and date of birth' end
    from patients p join patients o on o.tenant_id = p.tenant_id and o.id <> p.id and o.deleted_at is null
   where p.tenant_id = p_tenant and p.id = p_patient and (
         (p.phone_digits is not null and o.phone_digits = p.phone_digits
          and lower(split_part(btrim(o.full_name), ' ', 1)) = lower(split_part(btrim(p.full_name), ' ', 1)))
      or (p.date_of_birth is not null and o.date_of_birth = p.date_of_birth and lower(btrim(o.full_name)) = lower(btrim(p.full_name))))
   order by o.created_at;
$$;

-- "Checked: these are different people." Needs manage_patients; audited with the note.
create or replace function clear_duplicate_flag(p_tenant uuid, p_patient uuid, p_by uuid, p_note text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_patients') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  update patients set possible_duplicate = false where tenant_id = p_tenant and id = p_patient and possible_duplicate and deleted_at is null;
  if not found then raise exception 'NOT_FLAGGED' using errcode = 'P0001'; end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, patient_id, outcome, reason)
  values (p_tenant, 'member', p_by, 'patient.duplicate_cleared', 'patient', p_patient::text, p_patient, 'success', nullif(btrim(left(p_note, 200)), ''));
end $$;

revoke all on function patient_duplicate_candidates(uuid, uuid), clear_duplicate_flag(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function patient_duplicate_candidates(uuid, uuid), clear_duplicate_flag(uuid, uuid, uuid, text) to service_role;
