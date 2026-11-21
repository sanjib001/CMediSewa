-- =============================================================================
-- 0049 SCHEDULED JOBS (B9b): appointment reminders (queued on confirmation, sent by the
-- dispatcher when due), no-show marking, expired booking requests, the daily stock scan
-- notification, subscription-ending warnings, and housekeeping of sign-in records.
-- All of it runs from run_daily_jobs(), called by /api/cron/daily (Vercel Cron).
-- Decisions D-118, D-119.
-- =============================================================================

alter table tenant_settings
  add column reminder_hours_before smallint not null default 24 check (reminder_hours_before between 0 and 72);
comment on column tenant_settings.reminder_hours_before is 'Hours before an appointment to email a reminder; 0 = no reminders.';

-- The appointment trigger now also queues the reminder when an appointment is confirmed,
-- due reminder_hours_before ahead (skipped if that moment is already less than 30 minutes
-- away). Cancelling still cancels it (B9a).
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
      'Dr. ' || (select display_name from tenant_members where id = new.doctor_member_id) || ', ' || v_when || '. Call to confirm.',
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


-- ── the daily jobs ────────────────────────────────────────────────────────────
-- Confirmed appointments whose business day is over and who never checked in.
create or replace function mark_no_shows(p_tenant uuid default null)
returns integer
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare r record; n integer := 0; k integer;
begin
  for r in select t.id from tenants t where t.status = 'active' and (p_tenant is null or t.id = p_tenant) loop
    update appointments set status = 'no_show'
     where tenant_id = r.id and status = 'confirmed' and appointment_date < business_day(r.id, now());
    get diagnostics k = row_count;
    if k > 0 then
      insert into audit_log (tenant_id, actor_kind, action, outcome, detail) values (r.id, 'system', 'appointment.no_show', 'success', jsonb_build_object('count', k));
      n := n + k;
    end if;
  end loop;
  return n;
end $$;

-- Once a day per clinic: if anything is expired, near expiry or low, tell the people who
-- manage stock (counts only; the screens hold the detail).
create or replace function daily_stock_scan(p_tenant uuid default null)
returns integer
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare r record; v_exp integer; v_near integer; v_low integer; n integer := 0; v_day date; v_parts text[];
begin
  for r in select t.id from tenants t where t.status = 'active' and (p_tenant is null or t.id = p_tenant)
              and exists (select 1 from stock_balances b where b.tenant_id = t.id) loop
    select count(*) filter (where kind = 'expired'), count(*) filter (where kind = 'near_expiry'), count(*) filter (where kind in ('critical_stock', 'low_stock'))
      into v_exp, v_near, v_low from stock_alerts(r.id, null);
    if v_exp + v_near + v_low = 0 then continue; end if;
    v_day := business_day(r.id, now());
    v_parts := array_remove(array[
      case when v_exp > 0 then v_exp || ' expired batch' || case when v_exp > 1 then 'es' else '' end || ' still on hand' end,
      case when v_near > 0 then v_near || ' expiring soon' end,
      case when v_low > 0 then v_low || ' item' || case when v_low > 1 then 's' else '' end || ' low on stock' end], null);
    n := n + notify_members(r.id, 'manage_stock', 'stock_alerts', 'Stock needs attention', array_to_string(v_parts, ', ') || '.',
                            case when v_low > 0 and v_exp + v_near = 0 then '/admin/stock/reorder' else '/admin/reports?r=expiry' end,
                            'stock_scan', v_day::text);
  end loop;
  return n;
end $$;

-- A week before the paid-until date (once per date), tell the clinic's admins.
create or replace function warn_subscriptions_ending(p_tenant uuid default null)
returns integer
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare r record; n integer := 0; v_today date := (now() at time zone 'Asia/Kathmandu')::date;
begin
  for r in select t.id, tenant_paid_until(t.id) until from tenants t where t.status = 'active' and (p_tenant is null or t.id = p_tenant) loop
    if r.until is null or r.until < v_today or r.until > v_today + 7 then continue; end if;
    n := n + notify_members(r.id, 'manage_settings', 'subscription_ending', 'Subscription ending soon',
      'Your CMediSewa subscription is paid until ' || to_char(r.until, 'DD Mon YYYY') || '. Renew to keep the clinic running.',
      '/admin/settings', 'subscription', r.until::text);
  end loop;
  return n;
end $$;

-- Sign-in records kept only as long as they're useful (P-10 defaults until the policy is set).
create or replace function prune_sign_in_records()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare a integer; b integer; s integer;
begin
  delete from pin_attempts where at < now() - interval '90 days'; get diagnostics a = row_count;
  delete from auth_login_attempts where at < now() - interval '90 days'; get diagnostics b = row_count;
  delete from session_assurance where expires_at < now() - interval '1 day'; get diagnostics s = row_count;
  return jsonb_build_object('pin_attempts', a, 'login_attempts', b, 'sessions', s);
end $$;

-- Everything daily, in one call (the nightly ledger/payables/books checks run alongside it
-- from the same route through reconcile_all_tenants()).
create or replace function run_daily_jobs(p_tenant uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_req integer := 0; t uuid;
begin
  for t in select id from tenants where status = 'active' and (p_tenant is null or id = p_tenant) loop
    v_req := v_req + expire_booking_requests(t);
  end loop;
  return jsonb_build_object(
    'suspended', case when p_tenant is null then suspend_expired_tenants() else 0 end,
    'requests_expired', v_req,
    'no_shows', mark_no_shows(p_tenant),
    'stock_notified', daily_stock_scan(p_tenant),
    'subscription_warned', warn_subscriptions_ending(p_tenant),
    'pruned', case when p_tenant is null then prune_sign_in_records() else '{}'::jsonb end);
end $$;

revoke all on function mark_no_shows(uuid), daily_stock_scan(uuid), warn_subscriptions_ending(uuid), prune_sign_in_records(), run_daily_jobs(uuid)
  from public, anon, authenticated;
grant execute on function run_daily_jobs(uuid) to service_role;
