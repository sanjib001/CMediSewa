-- =============================================================================
-- 0031 WEBSITE BOOKING REQUESTS (B4c, D-82). A visitor on the clinic page can only send a
-- REQUEST (no account, no payment, D-83). It holds the chosen time while open. The registrar
-- or admin contacts the person (phone / Gmail), then approves it, linking it to an existing
-- or new patient, or declines it with a reason. A request never creates a patient record.
-- Requests nobody reviewed before their time are closed by the system.
-- =============================================================================

alter table appointments
  add column requester_name  text check (length(btrim(requester_name)) between 2 and 120),
  add column requester_phone text check (requester_phone ~ '^[0-9+() -]{7,20}$'),
  add column requester_email text check (requester_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column requester_age   smallint check (requester_age between 0 and 130),
  add column requester_sex   text check (requester_sex in ('male', 'female', 'other')),
  add column request_ip      inet;
alter table appointments alter column patient_id drop not null;
-- Only an open or declined website request may lack a patient; everything else has one.
alter table appointments add constraint appointments_patient_required
  check (patient_id is not null or (source = 'online' and status in ('requested', 'cancelled') and requester_name is not null));
alter table appointments add constraint appointments_request_contact
  check (source <> 'online' or patient_id is not null or requester_phone is not null or requester_email is not null);
create index appointments_requests on appointments (tenant_id, status) where status = 'requested';

alter table site_settings alter column booking_enabled set default true;
update site_settings set booking_enabled = true where not booking_enabled;

-- A doctor is bookable from the website when listed publicly with a verified registration.
create or replace function public_doctor_ok(p_tenant uuid, p_doctor uuid)
returns boolean
language sql stable
set search_path = pg_catalog, public
as $$
  select exists (select 1 from doctor_profiles dp
                   join tenant_members m on m.id = dp.member_id and m.is_active and m.deleted_at is null
                   join member_credentials c on c.member_id = dp.member_id and c.profession = 'doctor' and c.verified_at is not null
                                            and (c.expires_on is null or c.expires_on >= current_date)
                  where dp.tenant_id = p_tenant and dp.member_id = p_doctor and dp.is_public);
$$;

-- The clinic, when it takes website requests: active, published, booking on.
create or replace function public_booking_clinic(p_slug text)
returns uuid
language sql stable
set search_path = pg_catalog, public
as $$
  select t.id from tenants t join site_settings s on s.tenant_id = t.id
   where t.slug = p_slug and t.status = 'active' and s.published and s.booking_enabled;
$$;

-- Free times a visitor may request: within the booking window, after the notice period,
-- and not already held (slots) or full (token sessions).
create or replace function public_booking_slots(p_slug text, p_doctor uuid, p_date date)
returns table (slot_start timestamptz, slot_end timestamptz, mode text, places_left integer)
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_t uuid := public_booking_clinic(p_slug); v_set tenant_settings; v_today date;
begin
  if v_t is null or not public_doctor_ok(v_t, p_doctor) then return; end if;
  select * into v_set from tenant_settings where tenant_id = v_t;
  select (now() at time zone timezone)::date into v_today from tenants where id = v_t;
  if p_date < v_today or p_date > v_today + v_set.booking_window_days then return; end if;
  return query
    select s.slot_start, s.slot_end, s.mode,
           (s.capacity - (select count(*) from appointments a where a.tenant_id = v_t and a.doctor_member_id = p_doctor
                            and a.scheduled_range = tstzrange(s.slot_start, s.slot_end)
                            and a.status in ('requested', 'confirmed', 'checked_in', 'in_consultation')))::integer
      from available_slots(v_t, p_doctor, p_date, p_date) s
     where s.slot_start >= now() + make_interval(mins => v_set.min_notice_minutes)
       and s.capacity > (select count(*) from appointments a where a.tenant_id = v_t and a.doctor_member_id = p_doctor
                           and a.scheduled_range = tstzrange(s.slot_start, s.slot_end)
                           and a.status in ('requested', 'confirmed', 'checked_in', 'in_consultation'))
     order by 1;
end $$;

-- Send a request. Limits: 5 requests per connection per clinic per day, and the clinic's
-- max open bookings per phone/email. Always 'requested' (never auto-confirmed, D-82).
create or replace function request_booking(
  p_slug text, p_doctor uuid, p_start timestamptz, p_name text, p_phone text, p_email text,
  p_age integer, p_sex text, p_reason text, p_token_hash text, p_ip inet
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_t uuid := public_booking_clinic(p_slug); v_set tenant_settings; v_tz text; v_slot record; v_id uuid; v_n integer;
  v_phone text := nullif(btrim(p_phone), ''); v_email text := nullif(lower(btrim(p_email)), '');
begin
  if v_t is null then raise exception 'BOOKING_CLOSED' using errcode = 'P0001'; end if;
  if not public_doctor_ok(v_t, p_doctor) then raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001'; end if;
  if coalesce(length(btrim(p_name)), 0) < 2 then raise exception 'NAME_REQUIRED' using errcode = 'P0001'; end if;
  if v_phone is null and v_email is null then raise exception 'CONTACT_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_set from tenant_settings where tenant_id = v_t;
  select timezone into v_tz from tenants where id = v_t;

  if p_ip is not null and (select count(*) from appointments where tenant_id = v_t and request_ip = p_ip and created_at > now() - interval '1 day') >= 5 then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  select count(*) into v_n from appointments
   where tenant_id = v_t and source = 'online' and status in ('requested', 'confirmed') and upper(scheduled_range) > now()
     and ((v_phone is not null and regexp_replace(requester_phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g'))
          or (v_email is not null and requester_email = v_email));
  if v_n >= v_set.max_active_online_bookings_per_phone then raise exception 'TOO_MANY_OPEN' using errcode = 'P0001'; end if;

  select * into v_slot from public_booking_slots(p_slug, p_doctor, (p_start at time zone v_tz)::date) s where s.slot_start = p_start;
  if v_slot.slot_start is null then raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001'; end if;
  if v_slot.mode = 'token' then
    perform pg_advisory_xact_lock(hashtextextended(v_t::text || p_doctor::text || p_start::text, 0));
    select count(*) into v_n from appointments
     where tenant_id = v_t and doctor_member_id = p_doctor and scheduled_range = tstzrange(v_slot.slot_start, v_slot.slot_end)
       and status in ('requested', 'confirmed', 'checked_in', 'in_consultation');
    -- Recount under the lock: places_left was read before it.
    if v_n >=(select capacity from available_slots(v_t, p_doctor, (p_start at time zone v_tz)::date, (p_start at time zone v_tz)::date) a where a.slot_start = p_start limit 1) then
      raise exception 'SESSION_FULL' using errcode = 'P0001';
    end if;
  end if;
  begin
    insert into appointments (tenant_id, patient_id, doctor_member_id, mode, appointment_date, scheduled_range, source, booked_by_kind, status,
                              reason_for_visit, manage_token_hash, requester_name, requester_phone, requester_email, requester_age, requester_sex, request_ip)
    values (v_t, null, p_doctor, v_slot.mode, (p_start at time zone v_tz)::date, tstzrange(v_slot.slot_start, v_slot.slot_end), 'online', 'guest', 'requested',
            nullif(btrim(left(p_reason, 300)), ''), p_token_hash, btrim(p_name), v_phone, v_email, p_age,
            case when p_sex in ('male', 'female', 'other') then p_sex end, p_ip)
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'SLOT_TAKEN' using errcode = 'P0001';
  end;
  insert into audit_log (tenant_id, actor_kind, action, target_type, target_id, outcome, detail)
  values (v_t, 'guest_token', 'appointment.request', 'appointment', v_id::text, 'success', jsonb_build_object('doctor', p_doctor, 'start', p_start, 'mode', v_slot.mode));
  return v_id;
end $$;

-- What the requester sees on their link.
create or replace function public_booking_status(p_slug text, p_token_hash text)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object('status', a.status, 'start', lower(a.scheduled_range), 'end', upper(a.scheduled_range), 'mode', a.mode,
           'doctor', m.display_name, 'name', coalesce(a.requester_name, p.full_name), 'reason', a.reason_for_visit,
           'cancel_reason', a.cancel_reason, 'cancelled_by', a.cancelled_by_kind,
           'can_cancel', a.status in ('requested', 'confirmed') and lower(a.scheduled_range) > now() + make_interval(hours => st.cancellation_cutoff_hours),
           'clinic', t.name, 'clinic_phone', coalesce(s.contact_phone, t.phone))
    from appointments a
    join tenants t on t.id = a.tenant_id and t.slug = p_slug
    join tenant_members m on m.id = a.doctor_member_id
    join tenant_settings st on st.tenant_id = a.tenant_id
    left join site_settings s on s.tenant_id = a.tenant_id
    left join patients p on p.id = a.patient_id
   where a.manage_token_hash = p_token_hash;
$$;

create or replace function cancel_booking_by_token(p_slug text, p_token_hash text, p_reason text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_a appointments; v_cut integer;
begin
  select a.* into v_a from appointments a join tenants t on t.id = a.tenant_id and t.slug = p_slug where a.manage_token_hash = p_token_hash for update of a;
  if v_a.id is null then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001'; end if;
  select cancellation_cutoff_hours into v_cut from tenant_settings where tenant_id = v_a.tenant_id;
  if v_a.status not in ('requested', 'confirmed') or lower(v_a.scheduled_range) <= now() + make_interval(hours => v_cut) then
    raise exception 'TOO_LATE_TO_CANCEL' using errcode = 'P0001';
  end if;
  update appointments set status = 'cancelled', cancelled_at = now(), cancelled_by_kind = 'guest',
         cancel_reason = coalesce(nullif(btrim(left(p_reason, 200)), ''), 'Cancelled by the patient')
   where id = v_a.id;
  insert into audit_log (tenant_id, actor_kind, action, target_type, target_id, outcome)
  values (v_a.tenant_id, 'guest_token', 'appointment.cancelled', 'appointment', v_a.id::text, 'success');
end $$;

-- Staff approve a request after contacting the person, linking it to a patient record.
create or replace function approve_booking_request(p_tenant uuid, p_appointment uuid, p_patient uuid, p_by uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_a appointments;
begin
  perform assert_active_member(p_tenant, p_by);
  select * into v_a from appointments where id = p_appointment and tenant_id = p_tenant for update;
  if v_a.id is null then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_a.status <> 'requested' then raise exception 'REQUEST_NOT_OPEN' using errcode = 'P0001'; end if;
  if lower(v_a.scheduled_range) <= now() then raise exception 'REQUEST_EXPIRED' using errcode = 'P0001'; end if;
  if not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  begin
    update appointments set patient_id = p_patient, status = 'confirmed' where id = p_appointment;
  exception when exclusion_violation then
    raise exception 'PATIENT_ALREADY_BOOKED' using errcode = 'P0001';
  end;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, 'appointment.approve', 'appointment', p_appointment::text, 'success', jsonb_build_object('patient', p_patient));
end $$;

-- Requests nobody reviewed before their time: closed by the system (frees nothing in the
-- future, but keeps the request list honest). Called when the list is loaded and by the job.
create or replace function expire_booking_requests(p_tenant uuid)
returns integer
language sql security definer
set search_path = pg_catalog, public
as $$
  with x as (
    update appointments set status = 'cancelled', cancelled_at = now(), cancelled_by_kind = 'system', cancel_reason = 'Not reviewed before the appointment time'
     where tenant_id = p_tenant and status = 'requested' and lower(scheduled_range) <= now()
    returning 1)
  select count(*)::integer from x;
$$;

revoke all on function public_doctor_ok(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public_booking_clinic(text) from public, anon, authenticated, service_role;
revoke all on function public_booking_slots(text, uuid, date) from public, anon, authenticated;
revoke all on function request_booking(text, uuid, timestamptz, text, text, text, integer, text, text, text, inet) from public, anon, authenticated;
revoke all on function public_booking_status(text, text) from public, anon, authenticated;
revoke all on function cancel_booking_by_token(text, text, text) from public, anon, authenticated;
revoke all on function approve_booking_request(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function expire_booking_requests(uuid) from public, anon, authenticated;
grant execute on function public_booking_slots(text, uuid, date) to service_role;
grant execute on function request_booking(text, uuid, timestamptz, text, text, text, integer, text, text, text, inet) to service_role;
grant execute on function public_booking_status(text, text) to service_role;
grant execute on function cancel_booking_by_token(text, text, text) to service_role;
grant execute on function approve_booking_request(uuid, uuid, uuid, uuid) to service_role;
grant execute on function expire_booking_requests(uuid) to service_role;
