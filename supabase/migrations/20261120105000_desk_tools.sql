-- =============================================================================
-- 0051 DESK TOOLS (U4): printing an issued prescription at the desk (print_prescriptions,
-- A1, audited: permissions.md), finding which of today's visits have one, and rescheduling an
-- appointment in one step (the old one is cancelled, the new one remembers it, and the
-- patient gets one "rescheduled" email instead of "cancelled" + "confirmed").
-- Decisions D-121, D-122.
-- =============================================================================

-- Today's visits that have an issued prescription (ids and numbers only, no content).
create or replace function visit_prescriptions(p_tenant uuid, p_member uuid, p_day date)
returns table (visit_id uuid, prescription_id uuid, rx_number text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select v.id, rx.id, rx.rx_number
    from visits v join encounters e on e.visit_id = v.id join prescriptions rx on rx.encounter_id = e.id and rx.status = 'issued'
   where v.tenant_id = p_tenant and v.visit_date = p_day and has_key(p_member, 'print_prescriptions');
$$;

-- What a printed prescription shows: clinic, doctor (with a verified registration), patient,
-- the medicines and the doctor's advice. Never the diagnosis or the consultation notes.
create or replace function print_prescription(p_tenant uuid, p_member uuid, p_rx uuid, p_session_level text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare rx prescriptions; v jsonb;
begin
  perform assert_active_member(p_tenant, p_member);
  if not has_key(p_member, 'print_prescriptions') then
    insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason)
    values (p_tenant, 'member', p_member, p_session_level, 'prescription.print', 'prescription', p_rx::text, 'denied', 'no_print_right');
    return jsonb_build_object('error', 'NO_PERMISSION');
  end if;
  select * into rx from prescriptions where id = p_rx and tenant_id = p_tenant and status = 'issued';
  if rx.id is null then return jsonb_build_object('error', 'NOT_FOUND'); end if;
  select jsonb_build_object(
    'rx_number', rx.rx_number, 'issued_at', rx.issued_at, 'notes', rx.notes,
    'clinic', (select jsonb_build_object('name', coalesce(bp.legal_name, t.name), 'address', bp.address, 'phone', coalesce(bp.phone, t.phone))
                 from tenants t left join billing_profiles bp on bp.tenant_id = t.id and bp.is_default where t.id = p_tenant limit 1),
    'doctor', (select jsonb_build_object('name', tm.display_name,
                 'registration', (select mc.council || ' ' || mc.registration_no from member_credentials mc
                                   where mc.member_id = tm.id and mc.profession = 'doctor' and mc.verified_at is not null and (mc.expires_on is null or mc.expires_on >= current_date) order by mc.verified_at desc limit 1))
                 from tenant_members tm where tm.id = rx.doctor_member_id),
    'patient', (select jsonb_build_object('full_name', p.full_name, 'mrn', p.mrn, 'sex', p.sex, 'date_of_birth', p.date_of_birth, 'age_years', p.age_years, 'created_at', p.created_at)
                  from patients p where p.id = rx.patient_id),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('medicine_text', i.medicine_text, 'strength', i.strength, 'form', i.form, 'dose', i.dose, 'frequency', i.frequency,
                'duration_days', i.duration_days, 'quantity', i.quantity, 'instructions', i.instructions) order by i.line_no), '[]') from prescription_items i where i.prescription_id = rx.id))
    into v;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, patient_id, outcome)
  values (p_tenant, 'member', p_member, p_session_level, 'prescription.print', 'prescription', rx.id::text, rx.patient_id, 'success');
  return v;
end $$;

-- Move a confirmed (or requested) appointment to a new time, optionally with another doctor.
-- One transaction: the old one is cancelled ("Rescheduled"), the new one is booked through
-- book_appointment (every slot rule applies) and points back to it.
create or replace function reschedule_appointment(p_tenant uuid, p_appointment uuid, p_start timestamptz, p_doctor uuid, p_by uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare a appointments; v_new uuid; v_when text;
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_appointments') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  select * into a from appointments where id = p_appointment and tenant_id = p_tenant for update;
  if a.id is null then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if a.status <> 'confirmed' or a.patient_id is null then raise exception 'NOT_RESCHEDULABLE' using errcode = 'P0001'; end if;
  v_when := (select to_char(p_start at time zone timezone, 'DD Mon HH24:MI') from tenants where id = p_tenant);
  update appointments set status = 'cancelled', cancelled_at = now(), cancelled_by_kind = 'member', cancel_reason = 'Rescheduled to ' || v_when where id = a.id;
  v_new := book_appointment(p_tenant, a.patient_id, coalesce(p_doctor, a.doctor_member_id), p_start, a.service_id, a.source, a.reason_for_visit, 'member', p_by, null);
  update appointments set rescheduled_from_id = a.id where id = v_new;
  -- one email: "rescheduled" (with the new time) instead of "cancelled" + "confirmed"
  update notification_outbox set status = 'cancelled' where ref_type = 'appointment' and ref_id = a.id::text and kind = 'booking_cancelled' and status = 'pending';
  update notification_outbox set kind = 'booking_rescheduled' where ref_type = 'appointment' and ref_id = v_new::text and kind = 'booking_confirmed' and status = 'pending';
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, patient_id, outcome, detail)
  values (p_tenant, 'member', p_by, 'appointment.reschedule', 'appointment', v_new::text, a.patient_id, 'success', jsonb_build_object('from', a.id));
  return v_new;
end $$;

revoke all on function visit_prescriptions(uuid, uuid, date), print_prescription(uuid, uuid, uuid, text), reschedule_appointment(uuid, uuid, timestamptz, uuid, uuid) from public, anon, authenticated;
grant execute on function visit_prescriptions(uuid, uuid, date), print_prescription(uuid, uuid, uuid, text), reschedule_appointment(uuid, uuid, timestamptz, uuid, uuid) to service_role;
