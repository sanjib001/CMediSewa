-- =============================================================================
-- 0055 MANAGE LINKS IN EMAILS (U7): every confirmation, reminder and "moved" email carries a
-- private link to see or cancel the appointment. Only the HMAC of a token is stored (the app
-- holds the key), so the dispatcher mints a fresh token per email and records its hash here;
-- the website's original link keeps working. Status and cancel accept either.
-- Decision D-133.
-- =============================================================================

create table appointment_links (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  appointment_id  uuid not null,
  token_hash      text not null unique check (length(token_hash) between 20 and 100),
  created_via     text not null default 'email' check (created_via in ('email')),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, appointment_id) references appointments (tenant_id, id) on delete cascade
);
create index appointment_links_appointment on appointment_links (appointment_id);
alter table appointment_links enable row level security;
revoke insert, update, delete on appointment_links from service_role;

-- The dispatcher records the hash of the token it is about to email (one per email).
create or replace function add_manage_link(p_appointment uuid, p_token_hash text)
returns void
language sql security definer
set search_path = pg_catalog, public
as $$
  insert into appointment_links (tenant_id, appointment_id, token_hash)
  select a.tenant_id, a.id, p_token_hash from appointments a where a.id = p_appointment;
$$;

-- Which appointment a token opens: the website link, or one sent by email.
create or replace function appointment_by_token(p_slug text, p_token_hash text)
returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select a.id from appointments a join tenants t on t.id = a.tenant_id and t.slug = p_slug
   where a.manage_token_hash = p_token_hash
      or a.id = (select l.appointment_id from appointment_links l where l.token_hash = p_token_hash and l.tenant_id = a.tenant_id)
   limit 1;
$$;

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
   where a.id = appointment_by_token(p_slug, p_token_hash);
$$;

create or replace function cancel_booking_by_token(p_slug text, p_token_hash text, p_reason text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_a appointments; v_cut integer;
begin
  select a.* into v_a from appointments a where a.id = appointment_by_token(p_slug, p_token_hash) for update;
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

revoke all on function add_manage_link(uuid, text), appointment_by_token(text, text) from public, anon, authenticated;
grant execute on function add_manage_link(uuid, text) to service_role;
revoke all on function appointment_by_token(text, text) from service_role;
