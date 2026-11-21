-- =============================================================================
-- 0048 REALTIME & NOTIFICATIONS (B9a): a topic-only event table for live screens (D-09 as
-- built for Vercel: short SSE + catch-up from the last event id), in-app notifications for
-- staff, web-push subscriptions, and the notification outbox (D-10): one row per event,
-- channel and recipient, written in the same transaction as the event, dispatched by cron
-- with retries. Payloads are PHI-minimal: never a reason for visit, diagnosis or medicine.
-- Decisions D-114..D-117.
-- =============================================================================

-- ── live events (topic only; clients refetch through permission-checked pages) ──
create table realtime_events (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants (id) on delete cascade,
  topic       text not null check (topic in ('queue', 'bookings', 'dispensing', 'billing', 'stock', 'notifications')),
  member_id   uuid,                                   -- set only for one person's topic (their notifications)
  txid        bigint not null default txid_current(),
  created_at  timestamptz not null default now()
);
-- One event per topic (and person) per transaction, however many rows it touched.
create unique index realtime_events_once on realtime_events (tenant_id, topic, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid), txid);
create index realtime_events_recent on realtime_events (tenant_id, id);

create or replace function emit_event(p_tenant uuid, p_topic text, p_member uuid default null)
returns void
language sql security definer
set search_path = pg_catalog, public
as $$
  insert into realtime_events (tenant_id, topic, member_id) values (p_tenant, p_topic, p_member)
  on conflict (tenant_id, topic, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid), txid) do nothing;
$$;

-- Events after a given id, for the topics a page listens to (and this person's own).
create or replace function events_since(p_tenant uuid, p_member uuid, p_after bigint, p_topics text[])
returns table (id bigint, topic text)
language sql stable
set search_path = pg_catalog, public
as $$
  select e.id, e.topic from realtime_events e
   where e.tenant_id = p_tenant and e.id > coalesce(p_after, 0) and e.topic = any (p_topics)
     and (e.member_id is null or e.member_id = p_member)
   order by e.id limit 200;
$$;
create or replace function latest_event_id(p_tenant uuid)
returns bigint
language sql stable
set search_path = pg_catalog, public
as $$ select coalesce(max(id), 0) from realtime_events where tenant_id = p_tenant; $$;

-- ── in-app notifications ──────────────────────────────────────────────────────
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  member_id   uuid not null,
  kind        text not null check (kind ~ '^[a-z_]{3,40}$'),
  title       text not null check (length(title) between 1 and 120),
  body        text check (length(body) <= 300),
  link        text check (link ~ '^/[A-Za-z0-9/_?=&%.-]*$'),
  ref_type    text not null,
  ref_id      text not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, member_id, ref_type, ref_id, kind),
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id)
);
create index notifications_inbox on notifications (tenant_id, member_id, created_at desc);

create table push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  member_id     uuid not null,
  endpoint      text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh        text not null check (length(p256dh) between 20 and 200),
  auth          text not null check (length(auth) between 8 and 100),
  user_agent    text check (length(user_agent) <= 300),
  created_at    timestamptz not null default now(),
  last_sent_at  timestamptz,
  disabled_at   timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, member_id) references tenant_members (tenant_id, id)
);

-- ── outbox ────────────────────────────────────────────────────────────────────
create table notification_outbox (
  id               bigserial primary key,
  tenant_id        uuid not null references tenants (id) on delete cascade,
  channel          text not null check (channel in ('email', 'push')),
  kind             text not null check (kind ~ '^[a-z_]{3,40}$'),
  ref_type         text not null,
  ref_id           text not null,
  recipient        text not null,                    -- an email address, or a push subscription id
  payload          jsonb not null,
  status           text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped', 'cancelled')),
  attempts         smallint not null default 0,
  next_attempt_at  timestamptz not null default now(),
  claimed_at       timestamptz,
  sent_at          timestamptz,
  last_error       text check (length(last_error) <= 500),
  created_at       timestamptz not null default now(),
  unique (ref_type, ref_id, kind, channel, recipient)
);
create index notification_outbox_due on notification_outbox (next_attempt_at) where status in ('pending', 'sending');

alter table realtime_events     enable row level security;
alter table notifications       enable row level security;
alter table push_subscriptions  enable row level security;
alter table notification_outbox enable row level security;
revoke insert, update, delete on realtime_events, notifications, push_subscriptions, notification_outbox from service_role;

-- Notify every active member holding a key: an in-app notification, a live signal, and a
-- push to each of their devices. Text must be PHI-minimal (callers never pass clinical text).
create or replace function notify_members(p_tenant uuid, p_key text, p_kind text, p_title text, p_body text, p_link text, p_ref_type text, p_ref_id text)
returns integer
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare m record; n integer := 0;
begin
  for m in select tm.id from tenant_members tm where tm.tenant_id = p_tenant and tm.is_active and has_key(tm.id, p_key) loop
    insert into notifications (tenant_id, member_id, kind, title, body, link, ref_type, ref_id)
    values (p_tenant, m.id, p_kind, p_title, p_body, p_link, p_ref_type, p_ref_id)
    on conflict (tenant_id, member_id, ref_type, ref_id, kind) do nothing;
    if found then
      n := n + 1;
      perform emit_event(p_tenant, 'notifications', m.id);
      insert into notification_outbox (tenant_id, channel, kind, ref_type, ref_id, recipient, payload)
      select p_tenant, 'push', p_kind, p_ref_type, p_ref_id, ps.id::text, jsonb_build_object('title', p_title, 'body', p_body, 'link', p_link)
        from push_subscriptions ps where ps.member_id = m.id and ps.disabled_at is null
      on conflict do nothing;
    end if;
  end loop;
  return n;
end $$;

-- Queue an email (once per event, kind and address).
create or replace function queue_email(p_tenant uuid, p_kind text, p_ref_type text, p_ref_id text, p_to text, p_payload jsonb, p_at timestamptz default now())
returns void
language sql security definer
set search_path = pg_catalog, public
as $$
  insert into notification_outbox (tenant_id, channel, kind, ref_type, ref_id, recipient, payload, next_attempt_at)
  select p_tenant, 'email', p_kind, p_ref_type, p_ref_id, lower(btrim(p_to)), p_payload, p_at
   where p_to ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  on conflict do nothing;
$$;

-- ── triggers: the events that matter, in the same transaction ─────────────────
-- What a patient email may say about an appointment: clinic, doctor, date and time, clinic
-- phone. Never the reason for the visit.
create or replace function appointment_email_payload(a appointments)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object('clinic', t.name, 'clinic_phone', t.phone, 'doctor', tm.display_name,
    'date', to_char(lower(a.scheduled_range) at time zone t.timezone, 'YYYY-MM-DD'),
    'time', to_char(lower(a.scheduled_range) at time zone t.timezone, 'HH24:MI'), 'mode', a.mode,
    'patient_first_name', split_part(btrim(coalesce(p.full_name, a.requester_name, '')), ' ', 1), 'cancel_reason', null)
    from tenants t join tenant_members tm on tm.id = a.doctor_member_id left join patients p on p.id = a.patient_id
   where t.id = a.tenant_id;
$$;

create or replace function appointments_notify()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_email text; v_when text;
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
  end if;
  if tg_op = 'UPDATE' and new.status = 'cancelled' and old.status in ('requested', 'confirmed') then
    perform queue_email(new.tenant_id, case when old.status = 'requested' then 'booking_declined' else 'booking_cancelled' end, 'appointment', new.id::text, v_email,
      appointment_email_payload(new) || jsonb_build_object('cancel_reason', case when new.cancelled_by_kind = 'member' then null else new.cancel_reason end));
    -- anything still waiting to go out about this appointment (e.g. a reminder) is cancelled
    update notification_outbox set status = 'cancelled' where ref_type = 'appointment' and ref_id = new.id::text and status = 'pending' and kind not in ('booking_declined', 'booking_cancelled');
  end if;
  return null;
end $$;
create trigger appointments_notify after insert or update of status on appointments for each row execute function appointments_notify();

create or replace function visits_notify() returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$ begin perform emit_event(new.tenant_id, 'queue'); return null; end $$;
create trigger visits_notify after insert or update on visits for each row execute function visits_notify();

-- A prescription issued → pharmacists (no patient name, no medicines in the text).
create or replace function prescriptions_notify() returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if new.status = 'issued' and old.status is distinct from 'issued' then
    perform emit_event(new.tenant_id, 'dispensing');
    perform notify_members(new.tenant_id, 'dispense_prescription', 'rx_issued', 'Prescription to dispense',
      new.rx_number || ' from Dr. ' || (select display_name from tenant_members where id = new.doctor_member_id) || '.',
      '/employee/pharmacy?tab=dispense', 'prescription', new.id::text);
  end if;
  return null;
end $$;
create trigger prescriptions_notify after update of status on prescriptions for each row execute function prescriptions_notify();

create or replace function invoices_notify() returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$ begin perform emit_event(new.tenant_id, 'billing'); perform emit_event(new.tenant_id, 'dispensing'); return null; end $$;
create trigger invoices_notify after insert or update on invoices for each row execute function invoices_notify();

create or replace function stock_balances_notify() returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$ begin perform emit_event(coalesce(new.tenant_id, old.tenant_id), 'stock'); return null; end $$;
create trigger stock_balances_notify after insert or update on stock_balances for each row execute function stock_balances_notify();

-- ── app-facing functions ──────────────────────────────────────────────────────
create or replace function mark_notifications_read(p_tenant uuid, p_member uuid, p_ids uuid[])
returns integer
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare n integer;
begin
  update notifications set read_at = now()
   where tenant_id = p_tenant and member_id = p_member and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  if n > 0 then perform emit_event(p_tenant, 'notifications', p_member); end if;
  return n;
end $$;

-- A device's push subscription belongs to whoever signed in on it last.
create or replace function save_push_subscription(p_tenant uuid, p_member uuid, p_endpoint text, p_p256dh text, p_auth text, p_ua text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v uuid;
begin
  perform assert_active_member(p_tenant, p_member);
  insert into push_subscriptions (tenant_id, member_id, endpoint, p256dh, auth, user_agent)
  values (p_tenant, p_member, p_endpoint, p_p256dh, p_auth, left(p_ua, 300))
  on conflict (endpoint) do update set tenant_id = excluded.tenant_id, member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth,
                                       user_agent = excluded.user_agent, disabled_at = null, created_at = now()
  returning id into v;
  return v;
end $$;
create or replace function remove_push_subscription(p_tenant uuid, p_member uuid, p_endpoint text)
returns void
language sql security definer
set search_path = pg_catalog, public
as $$ update push_subscriptions set disabled_at = now() where tenant_id = p_tenant and member_id = p_member and endpoint = p_endpoint and disabled_at is null; $$;

-- The dispatcher claims due rows (skip locked, so two runs never take the same row; a row
-- stuck in 'sending' for 10 minutes is claimed again).
create or replace function claim_outbox(p_limit integer)
returns setof notification_outbox
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  update notification_outbox o set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
   where o.id in (select x.id from notification_outbox x
                   where (x.status = 'pending' and x.next_attempt_at <= now()) or (x.status = 'sending' and x.claimed_at < now() - interval '10 minutes')
                   order by x.next_attempt_at limit greatest(1, least(coalesce(p_limit, 50), 200)) for update skip locked)
  returning o.*;
end $$;

-- sent | skipped (e.g. no mail key: a dry run) | retry (backoff; failed after 5 tries) | failed.
-- p_disable: the push service said the subscription is gone.
create or replace function complete_outbox(p_id bigint, p_result text, p_error text, p_disable boolean default false)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare o notification_outbox;
begin
  select * into o from notification_outbox where id = p_id and status = 'sending' for update;
  if o.id is null then return; end if;
  if p_result = 'sent' then
    update notification_outbox set status = 'sent', sent_at = now(), last_error = null where id = p_id;
    if o.channel = 'push' then update push_subscriptions set last_sent_at = now() where id::text = o.recipient; end if;
  elsif p_result = 'skipped' then
    update notification_outbox set status = 'skipped', last_error = left(p_error, 500) where id = p_id;
  elsif p_result = 'retry' and o.attempts < 5 then
    update notification_outbox set status = 'pending', next_attempt_at = now() + make_interval(mins => o.attempts * o.attempts * 2), last_error = left(p_error, 500) where id = p_id;
  else
    update notification_outbox set status = 'failed', last_error = left(p_error, 500) where id = p_id;
  end if;
  if p_disable and o.channel = 'push' then update push_subscriptions set disabled_at = now() where id::text = o.recipient; end if;
end $$;

-- Housekeeping (the dispatcher calls it): live events older than a day, old outbox rows.
create or replace function prune_notifications()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare e integer; o integer;
begin
  delete from realtime_events where created_at < now() - interval '1 day'; get diagnostics e = row_count;
  delete from notification_outbox where status in ('sent', 'skipped', 'cancelled', 'failed') and created_at < now() - interval '90 days'; get diagnostics o = row_count;
  return jsonb_build_object('events', e, 'outbox', o);
end $$;

-- ── privileges ────────────────────────────────────────────────────────────────
revoke all on function emit_event(uuid, text, uuid), notify_members(uuid, text, text, text, text, text, text, text),
                       queue_email(uuid, text, text, text, text, jsonb, timestamptz), appointment_email_payload(appointments),
                       appointments_notify(), visits_notify(), prescriptions_notify(), invoices_notify(), stock_balances_notify()
  from public, anon, authenticated, service_role;
revoke all on function events_since(uuid, uuid, bigint, text[]), latest_event_id(uuid), mark_notifications_read(uuid, uuid, uuid[]),
                       save_push_subscription(uuid, uuid, text, text, text, text), remove_push_subscription(uuid, uuid, text),
                       claim_outbox(integer), complete_outbox(bigint, text, text, boolean), prune_notifications()
  from public, anon, authenticated;
grant execute on function events_since(uuid, uuid, bigint, text[]), latest_event_id(uuid), mark_notifications_read(uuid, uuid, uuid[]),
                          save_push_subscription(uuid, uuid, text, text, text, text), remove_push_subscription(uuid, uuid, text),
                          claim_outbox(integer), complete_outbox(bigint, text, text, boolean), prune_notifications()
  to service_role;
-- the posting functions (owned by ledger_writer) fire these triggers; they run as their owner
