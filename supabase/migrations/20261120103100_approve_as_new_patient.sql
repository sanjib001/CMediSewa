-- 0032 Found by the B4c end-to-end test: approving a request "as a new patient" registered
-- the patient first and approved second, so a failed approval (e.g. already handled by a
-- colleague) left a duplicate patient behind. Both now happen in ONE transaction.
create or replace function approve_booking_request_new_patient(
  p_tenant uuid, p_appointment uuid, p_full_name text, p_sex text, p_age integer, p_dob date, p_phone text, p_by uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_a appointments; v_patient uuid;
begin
  perform assert_active_member(p_tenant, p_by);
  select * into v_a from appointments where id = p_appointment and tenant_id = p_tenant for update;
  if v_a.id is null then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_a.status <> 'requested' then raise exception 'REQUEST_NOT_OPEN' using errcode = 'P0001'; end if;
  insert into patients (tenant_id, full_name, sex, age_years, date_of_birth, phone, email, created_via, created_by)
  values (p_tenant, btrim(p_full_name), p_sex, case when p_dob is null then p_age end, p_dob, nullif(btrim(p_phone), ''), v_a.requester_email, 'online', p_by)
  returning id into v_patient;
  perform approve_booking_request(p_tenant, p_appointment, v_patient, p_by);
  return v_patient;
end $$;
revoke all on function approve_booking_request_new_patient(uuid, uuid, text, text, integer, date, text, uuid) from public, anon, authenticated;
grant execute on function approve_booking_request_new_patient(uuid, uuid, text, text, integer, date, text, uuid) to service_role;
