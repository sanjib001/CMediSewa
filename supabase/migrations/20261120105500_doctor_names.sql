-- =============================================================================
-- 0056 DOCTOR NAMES (found in the browser UI pass): notifications read "Dr. Dr. Anjali" when the
-- display name already starts with "Dr.". dr_name() adds the title only when it's missing; the
-- three notification triggers below are their current definitions with only that changed.
-- Decision D-135.
-- =============================================================================

create or replace function dr_name(p_name text)
returns text
language sql immutable
set search_path = pg_catalog, public
as $$
  select case when coalesce(btrim(p_name), '') = '' then 'the doctor'
              when btrim(p_name) ~* '^dr\.?\s' then btrim(p_name)
              else 'Dr. ' || btrim(p_name) end;
$$;

create or replace function appointments_notify()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_email text; v_when text; v_remind timestamptz;
begin
  perform emit_event(new.tenant_id, 'bookings');
  perform emit_event(new.tenant_id, 'queue');
  select coalesce(p.email, new.requester_email) into v_email from (select 1) x left join patients p on p.id = new.patient_id;
  if tg_op = 'INSERT' and new.status = 'requested' then
    v_when := (select to_char(lower(new.scheduled_range) at time zone timezone, 'DD Mon HH24:MI') from tenants where id = new.tenant_id);
    perform notify_members(new.tenant_id, 'manage_appointments', 'booking_request', 'New booking request',
      dr_name((select display_name from tenant_members where id = new.doctor_member_id)) || ', ' || v_when || '. Call to confirm.',
      '/employee/registrar', 'appointment', new.id::text);
  end if;
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status is distinct from 'confirmed') then
    perform queue_email(new.tenant_id, 'booking_confirmed', 'appointment', new.id::text, v_email, appointment_email_payload(new));
    v_remind := lower(new.scheduled_range) - make_interval(hours => coalesce((select reminder_hours_before from tenant_settings where tenant_id = new.tenant_id), 24));
    if v_remind > now() + interval '30 minutes' and v_remind < lower(new.scheduled_range) then
      perform queue_email(new.tenant_id, 'booking_reminder', 'appointment', new.id::text, v_email, appointment_email_payload(new), v_remind);
    end if;
  end if;
  if tg_op = 'UPDATE' and new.status = 'cancelled' and old.status in ('requested', 'confirmed') then
    perform queue_email(new.tenant_id, case when old.status = 'requested' then 'booking_declined' else 'booking_cancelled' end, 'appointment', new.id::text, v_email,
      appointment_email_payload(new) || jsonb_build_object('cancel_reason', case when new.cancelled_by_kind = 'member' then null else new.cancel_reason end));
    -- anything still waiting to go out about this appointment (e.g. a reminder) is cancelled
    update notification_outbox set status = 'cancelled' where ref_type = 'appointment' and ref_id = new.id::text and status = 'pending' and kind not in ('booking_declined', 'booking_cancelled');
  end if;
  return null;
end $$;

create or replace function prescriptions_notify() returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if new.status = 'issued' and old.status is distinct from 'issued' then
    perform emit_event(new.tenant_id, 'dispensing');
    perform notify_members(new.tenant_id, 'dispense_prescription', 'rx_issued', 'Prescription to dispense',
      new.rx_number || ' from ' || dr_name((select display_name from tenant_members where id = new.doctor_member_id)) || '.',
      '/employee/pharmacy?tab=dispense', 'prescription', new.id::text);
  end if;
  return null;
end $$;

create or replace function schedule_exceptions_leave_notify()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare n integer;
begin
  if new.kind <> 'leave' then return null; end if;
  n := leave_overlaps(new.tenant_id, new.member_id, new.on_date, new.start_time, new.end_time);
  if n > 0 then
    perform notify_members(new.tenant_id, 'manage_appointments', 'doctor_leave', 'Doctor on leave: appointments to move',
      dr_name((select display_name from tenant_members where id = new.member_id)) || ' is on leave on ' || to_char(new.on_date, 'DD Mon')
        || case when new.start_time is not null then ' (' || to_char(new.start_time, 'HH24:MI') || '–' || to_char(new.end_time, 'HH24:MI') || ')' else '' end
        || '; ' || n || ' appointment' || case when n > 1 then 's need' else ' needs' end || ' moving.',
      '/employee/registrar', 'leave', new.id::text);
  end if;
  perform emit_event(new.tenant_id, 'bookings');
  return null;
end $$;

revoke all on function dr_name(text) from public, anon, authenticated;
grant execute on function dr_name(text) to service_role;
