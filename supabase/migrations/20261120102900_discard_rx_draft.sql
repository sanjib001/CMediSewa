-- 0030 A doctor who removes every medicine must be able to drop the draft prescription
-- (finalize_encounter refuses while a draft exists). Only a DRAFT, only the author.
create or replace function discard_prescription_draft(p_tenant uuid, p_member uuid, p_encounter uuid, p_session_level text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare e encounters;
begin
  select * into e from encounters where id = p_encounter and tenant_id = p_tenant;
  if e.id is null then raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0001'; end if;
  perform clinical_guard(p_tenant, p_member, e.patient_id, p_session_level, 'write', 'prescription.discard');
  if e.doctor_member_id <> p_member then raise exception 'NOT_YOUR_ENCOUNTER' using errcode = 'P0001'; end if;
  delete from prescriptions where encounter_id = p_encounter and status = 'draft';
end $$;
revoke all on function discard_prescription_draft(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function discard_prescription_draft(uuid, uuid, uuid, text) to service_role;
