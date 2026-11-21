-- =============================================================================
-- 0052 DOCTOR SCHEDULE (U5): a doctor's own leave (manage_own_leave), the desk told when leave
-- lands on booked appointments (W-06 §4: listed for reception to move, never auto-cancelled),
-- the list of those appointments, and a doctor booking a follow-up in their own diary.
-- Decisions D-123, D-124.
-- =============================================================================

-- Active appointments of a doctor that a leave row overlaps.
create or replace function leave_overlaps(p_tenant uuid, p_member uuid, p_date date, p_start time, p_end time)
returns integer
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select count(*)::integer from appointments a join tenants t on t.id = a.tenant_id
   where a.tenant_id = p_tenant and a.doctor_member_id = p_member and a.appointment_date = p_date and a.status in ('requested', 'confirmed')
     and (p_start is null or ((lower(a.scheduled_range) at time zone t.timezone)::time < p_end and (upper(a.scheduled_range) at time zone t.timezone)::time > p_start));
$$;

-- New leave on a day with bookings → the desk is told (whoever added the leave).
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
      'Dr. ' || (select display_name from tenant_members where id = new.member_id) || ' is on leave on ' || to_char(new.on_date, 'DD Mon')
        || case when new.start_time is not null then ' (' || to_char(new.start_time, 'HH24:MI') || '–' || to_char(new.end_time, 'HH24:MI') || ')' else '' end
        || '; ' || n || ' appointment' || case when n > 1 then 's need' else ' needs' end || ' moving.',
      '/employee/registrar', 'leave', new.id::text);
  end if;
  perform emit_event(new.tenant_id, 'bookings');
  return null;
end $$;
create trigger schedule_exceptions_leave_notify after insert on schedule_exceptions for each row execute function schedule_exceptions_leave_notify();

-- A doctor takes leave: whole days over a range (at most 60 days), or part of one day.
-- Days that already have a whole-day leave are skipped. Returns days added and bookings hit.
create or replace function add_own_leave(p_tenant uuid, p_member uuid, p_from date, p_to date, p_start time, p_end time, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare d date; v_days integer := 0; v_hit integer := 0; v_today date := stock_today(p_tenant);
begin
  perform assert_active_member(p_tenant, p_member);
  if not has_key(p_member, 'manage_own_leave') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if not exists (select 1 from doctor_profiles where tenant_id = p_tenant and member_id = p_member) then raise exception 'NOT_A_DOCTOR' using errcode = 'P0001'; end if;
  if p_from is null or p_to is null or p_from < v_today or p_to < p_from then raise exception 'BAD_DATES' using errcode = 'P0001'; end if;
  if p_to - p_from > 60 then raise exception 'TOO_LONG' using errcode = 'P0001'; end if;
  if (p_start is null) <> (p_end is null) or (p_start is not null and (p_end <= p_start or p_to <> p_from)) then raise exception 'BAD_TIMES' using errcode = 'P0001'; end if;
  for d in select generate_series(p_from, p_to, interval '1 day')::date loop
    continue when exists (select 1 from schedule_exceptions where tenant_id = p_tenant and member_id = p_member and on_date = d and kind = 'leave' and start_time is null);
    insert into schedule_exceptions (tenant_id, member_id, on_date, kind, start_time, end_time, reason)
    values (p_tenant, p_member, d, 'leave', p_start, p_end, nullif(btrim(left(p_reason, 200)), ''));
    v_days := v_days + 1;
    v_hit := v_hit + leave_overlaps(p_tenant, p_member, d, p_start, p_end);
  end loop;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_member, 'schedule.leave_add', 'tenant_member', p_member::text, 'success', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days, 'appointments', v_hit));
  return jsonb_build_object('days', v_days, 'appointments', v_hit);
end $$;

-- A doctor removes their own leave (today or later only).
create or replace function remove_own_leave(p_tenant uuid, p_member uuid, p_exception uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  perform assert_active_member(p_tenant, p_member);
  if not has_key(p_member, 'manage_own_leave') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  delete from schedule_exceptions where id = p_exception and tenant_id = p_tenant and member_id = p_member and kind = 'leave' and on_date >= stock_today(p_tenant);
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  perform emit_event(p_tenant, 'bookings');
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome)
  values (p_tenant, 'member', p_member, 'schedule.leave_remove', 'tenant_member', p_member::text, 'success');
end $$;

-- Appointments in the next p_days that fall on a doctor's leave (for the desk to move).
create or replace function appointments_on_leave(p_tenant uuid, p_days integer)
returns table (appointment_id uuid, starts_at timestamptz, ends_at timestamptz, doctor_member_id uuid, doctor text, patient_id uuid, patient text, mrn text, phone text, status text, mode text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select a.id, lower(a.scheduled_range), upper(a.scheduled_range), a.doctor_member_id, tm.display_name, a.patient_id,
         coalesce(p.full_name, a.requester_name), p.mrn, coalesce(p.phone, a.requester_phone), a.status, a.mode
    from appointments a join tenants t on t.id = a.tenant_id join tenant_members tm on tm.id = a.doctor_member_id left join patients p on p.id = a.patient_id
   where a.tenant_id = p_tenant and a.status in ('requested', 'confirmed')
     and a.appointment_date between stock_today(p_tenant) and stock_today(p_tenant) + least(greatest(coalesce(p_days, 30), 1), 90)
     and exists (select 1 from schedule_exceptions e where e.tenant_id = a.tenant_id and e.member_id = a.doctor_member_id and e.on_date = a.appointment_date and e.kind = 'leave'
                  and (e.start_time is null or ((lower(a.scheduled_range) at time zone t.timezone)::time < e.end_time and (upper(a.scheduled_range) at time zone t.timezone)::time > e.start_time)))
   order by 2;
$$;

-- A doctor books a follow-up in their own diary for a patient they have seen. All slot rules
-- apply (book_appointment); the patient gets the usual confirmation (and reminder).
create or replace function book_follow_up(p_tenant uuid, p_member uuid, p_patient uuid, p_start timestamptz)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v uuid;
begin
  perform assert_active_member(p_tenant, p_member);
  if not has_key(p_member, 'write_consultation') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if not exists (select 1 from encounters where tenant_id = p_tenant and patient_id = p_patient and doctor_member_id = p_member) then raise exception 'NOT_YOUR_PATIENT' using errcode = 'P0001'; end if;
  if p_start <= now() then raise exception 'IN_THE_PAST' using errcode = 'P0001'; end if;
  v := book_appointment(p_tenant, p_patient, p_member, p_start, null, 'follow_up', null, 'member', p_member, null);
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, patient_id, outcome)
  values (p_tenant, 'member', p_member, 'appointment.follow_up', 'appointment', v::text, p_patient, 'success');
  return v;
end $$;

revoke all on function leave_overlaps(uuid, uuid, date, time, time), schedule_exceptions_leave_notify() from public, anon, authenticated, service_role;
revoke all on function add_own_leave(uuid, uuid, date, date, time, time, text), remove_own_leave(uuid, uuid, uuid), appointments_on_leave(uuid, integer), book_follow_up(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function add_own_leave(uuid, uuid, date, date, time, time, text), remove_own_leave(uuid, uuid, uuid), appointments_on_leave(uuid, integer), book_follow_up(uuid, uuid, uuid, timestamptz)
  to service_role;
