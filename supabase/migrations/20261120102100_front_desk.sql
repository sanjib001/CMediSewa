-- =============================================================================
-- 0022 FRONT DESK (B4a): patients (MRN, duplicate flag), appointments (no double booking,
-- status machine), visits + per-doctor daily tokens, and the OPD fee bill + payment at
-- check-in (invoices, invoice_lines, payments, payment_allocations) posted to the journal.
-- database.md §6, §7, §11; workflows W-10..W-14; decisions D-11, D-35, D-43, D-44, D-49.
-- =============================================================================

-- ── patients ──────────────────────────────────────────────────────────────────
create table patient_mrn_counters (
  tenant_id  uuid primary key references tenants (id) on delete restrict,
  next_no    bigint not null default 1
);

create table patients (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete restrict,
  mrn                text not null,
  full_name          text not null check (length(btrim(full_name)) between 2 and 120),
  full_name_ne       text check (length(full_name_ne) <= 120),
  sex                text not null check (sex in ('male', 'female', 'other')),
  date_of_birth      date check (date_of_birth > date '1900-01-01'),
  age_years          smallint check (age_years between 0 and 130),
  phone              text check (phone ~ '^[0-9+() -]{7,20}$'),
  phone_digits       text generated always as (nullif(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '')) stored,
  alt_phone          text check (alt_phone ~ '^[0-9+() -]{7,20}$'),
  email              text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address            text check (length(address) <= 200),
  guardian_name      text check (length(guardian_name) <= 120),
  guardian_relation  text check (length(guardian_relation) <= 40),
  blood_group        text check (blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  created_via        text not null default 'desk' check (created_via in ('desk', 'online')),
  possible_duplicate boolean not null default false,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, mrn),
  foreign key (tenant_id, created_by) references tenant_members (tenant_id, id),
  check (date_of_birth is not null or age_years is not null)
);
create index patients_phone on patients (tenant_id, phone_digits) where phone_digits is not null;
create index patients_name  on patients (tenant_id, lower(full_name));
create trigger patients_touch before update on patients for each row execute function touch_updated_at();
comment on table patients is 'Per-clinic patient identity (D-20). MRN is stamped by trigger from a per-clinic counter and never changes. possible_duplicate is a hint for the desk, never a merge.';

create table patient_allergies (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  patient_id   uuid not null,
  allergen     text not null check (length(btrim(allergen)) between 2 and 80),
  reaction     text check (length(reaction) <= 200),
  severity     text check (severity in ('mild', 'moderate', 'severe')),
  recorded_by  uuid,
  created_at   timestamptz not null default now(),
  removed_at   timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, recorded_by) references tenant_members (tenant_id, id)
);

create or replace function patients_stamp()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_no bigint; v_first text := lower(split_part(btrim(new.full_name), ' ', 1));
begin
  insert into patient_mrn_counters as c (tenant_id, next_no) values (new.tenant_id, 2)
  on conflict (tenant_id) do update set next_no = c.next_no + 1
  returning next_no - 1 into v_no;
  new.mrn := lpad(v_no::text, 6, '0');
  -- Same phone and same first name, or same full name and date of birth: probably the
  -- same person registered twice. Flag only; staff decide.
  new.possible_duplicate := exists (
    select 1 from patients p where p.tenant_id = new.tenant_id and p.deleted_at is null and (
      (new.phone_digits is not null and p.phone_digits = new.phone_digits and lower(split_part(btrim(p.full_name), ' ', 1)) = v_first)
      or (new.date_of_birth is not null and p.date_of_birth = new.date_of_birth and lower(btrim(p.full_name)) = lower(btrim(new.full_name)))));
  return new;
end $$;
create trigger patients_stamp before insert on patients for each row execute function patients_stamp();
-- The MRN is permanent.
create or replace function patients_mrn_fixed()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.mrn is distinct from old.mrn or new.tenant_id is distinct from old.tenant_id then
    raise exception 'MRN_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger patients_mrn_fixed before update on patients for each row execute function patients_mrn_fixed();

-- Desk search: MRN, phone (any 4+ digits), or name. Never more than p_limit rows.
create or replace function search_patients(p_tenant uuid, p_q text, p_limit integer default 20)
returns setof patients
language sql stable
set search_path = pg_catalog, public
as $$
  with q as (select btrim(coalesce(p_q, '')) t, regexp_replace(coalesce(p_q, ''), '\D', '', 'g') d)
  select p.* from patients p, q
   where p.tenant_id = p_tenant and p.deleted_at is null and length(q.t) >= 2
     and (p.mrn = lpad(q.d, 6, '0') and length(q.d) between 1 and 6 and q.d = q.t
          or (length(q.d) >= 4 and q.d = regexp_replace(q.t, '[\s+()-]', '', 'g') and p.phone_digits like '%' || q.d || '%')
          or lower(p.full_name) like '%' || lower(q.t) || '%')
   order by (p.mrn = lpad(q.d, 6, '0')) desc, p.full_name
   limit least(greatest(p_limit, 1), 50);
$$;

-- ── appointments (D-11) ───────────────────────────────────────────────────────
create table appointments (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants (id) on delete restrict,
  patient_id           uuid not null,
  doctor_member_id     uuid not null,
  service_id           uuid,
  mode                 text not null check (mode in ('slot', 'token')),
  appointment_date     date not null,
  scheduled_range      tstzrange not null check (not isempty(scheduled_range)),
  source               text not null check (source in ('online', 'phone', 'walk_in', 'follow_up', 'desk')),
  booked_by_kind       text not null check (booked_by_kind in ('guest', 'patient_account', 'member')),
  booked_by_id         uuid,
  status               text not null default 'confirmed'
                       check (status in ('requested', 'confirmed', 'checked_in', 'in_consultation', 'completed', 'cancelled', 'no_show')),
  reason_for_visit     text check (length(reason_for_visit) <= 300),
  manage_token_hash    text unique,
  cancel_reason        text,
  cancelled_at         timestamptz,
  cancelled_by_kind    text check (cancelled_by_kind in ('guest', 'patient_account', 'member', 'system')),
  rescheduled_from_id  uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, doctor_member_id) references doctor_profiles (tenant_id, member_id),
  foreign key (tenant_id, service_id) references services (tenant_id, id),
  foreign key (tenant_id, rescheduled_from_id) references appointments (tenant_id, id),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  -- A time slot can be held by one active appointment only (D-11). Token sessions are
  -- shared up to their capacity, which book_appointment enforces under a lock.
  constraint appointments_no_double_booking exclude using gist (
    tenant_id with =, doctor_member_id with =, scheduled_range with &&
  ) where (mode = 'slot' and status in ('requested', 'confirmed', 'checked_in', 'in_consultation')),
  -- …and a patient cannot hold two overlapping active appointments.
  constraint appointments_patient_overlap exclude using gist (
    tenant_id with =, patient_id with =, scheduled_range with &&
  ) where (status in ('requested', 'confirmed', 'checked_in', 'in_consultation'))
);
create index appointments_doctor_day on appointments (tenant_id, doctor_member_id, appointment_date);
create index appointments_patient on appointments (tenant_id, patient_id, appointment_date desc);
create trigger appointments_touch before update on appointments for each row execute function touch_updated_at();

create or replace function appointments_status_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status = old.status then return new; end if;
  if not ((old.status = 'requested'       and new.status in ('confirmed', 'cancelled'))
       or (old.status = 'confirmed'       and new.status in ('checked_in', 'cancelled', 'no_show'))
       or (old.status = 'checked_in'      and new.status in ('in_consultation', 'completed', 'cancelled'))
       or (old.status = 'in_consultation' and new.status = 'completed')) then
    raise exception 'ILLEGAL_TRANSITION: % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger appointments_status_guard before update of status on appointments
  for each row execute function appointments_status_guard();

-- ── visits & tokens ───────────────────────────────────────────────────────────
create table token_counters (
  tenant_id         uuid not null,
  doctor_member_id  uuid not null,
  visit_date        date not null,
  next_token        integer not null default 1,
  primary key (tenant_id, doctor_member_id, visit_date),
  foreign key (tenant_id, doctor_member_id) references doctor_profiles (tenant_id, member_id)
);

create table visits (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete restrict,
  patient_id        uuid not null,
  doctor_member_id  uuid not null,
  service_id        uuid,
  appointment_id    uuid unique,
  visit_date        date not null,
  token_no          integer not null check (token_no > 0),
  status            text not null default 'waiting' check (status in ('waiting', 'with_doctor', 'awaiting_billing', 'closed', 'cancelled')),
  checked_in_at     timestamptz not null default now(),
  checked_in_by     uuid not null,
  called_at         timestamptz,
  closed_at         timestamptz,
  closed_by         uuid,
  cancel_reason     text,
  idempotency_key   uuid not null,
  unique (tenant_id, id),
  unique (tenant_id, doctor_member_id, visit_date, token_no),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, doctor_member_id) references doctor_profiles (tenant_id, member_id),
  foreign key (tenant_id, service_id) references services (tenant_id, id),
  foreign key (tenant_id, appointment_id) references appointments (tenant_id, id),
  foreign key (tenant_id, checked_in_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, closed_by) references tenant_members (tenant_id, id),
  check (status <> 'cancelled' or cancel_reason is not null)
);
create index visits_queue on visits (tenant_id, visit_date, doctor_member_id, token_no);
-- One live visit per patient per doctor per day.
create unique index visits_one_live on visits (tenant_id, patient_id, doctor_member_id, visit_date)
  where status in ('waiting', 'with_doctor', 'awaiting_billing');

-- ── billing documents (D-35): service lines now; item lines arrive with B7 ────
create table invoices (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete restrict,
  billing_profile_id  uuid not null,
  invoice_no          text not null,
  fiscal_year         text not null,
  visit_id            uuid,
  patient_id          uuid,
  customer_name       text,
  source              text not null check (source in ('counter', 'visit', 'dispensing')),
  status              text not null default 'issued' check (status in ('issued', 'void')),
  subtotal            numeric(12,2) not null check (subtotal >= 0),
  discount_total      numeric(12,2) not null default 0 check (discount_total >= 0),
  taxable_amount      numeric(12,2) not null default 0 check (taxable_amount >= 0),
  tax_total           numeric(12,2) not null default 0 check (tax_total >= 0),
  total               numeric(12,2) not null check (total >= 0),
  issued_by           uuid not null,
  issued_at           timestamptz not null default now(),
  posting_id          uuid not null,
  void_reason         text,
  voided_by           uuid,
  voided_at           timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, billing_profile_id, fiscal_year, invoice_no),
  foreign key (tenant_id, billing_profile_id) references billing_profiles (tenant_id, id),
  foreign key (tenant_id, visit_id) references visits (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, issued_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  check (total = subtotal - discount_total + tax_total)
);
create index invoices_patient on invoices (tenant_id, patient_id) where patient_id is not null;

create table invoice_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  invoice_id       uuid not null,
  line_no          smallint not null check (line_no > 0),
  line_type        text not null check (line_type in ('service', 'item')),
  service_id       uuid,
  description      text not null,
  qty              numeric(12,3) not null check (qty > 0),
  unit_price       numeric(12,2) not null check (unit_price >= 0),
  discount_amount  numeric(12,2) not null default 0 check (discount_amount >= 0),
  tax_rate         numeric(5,2) not null default 0 check (tax_rate >= 0),
  tax_amount       numeric(12,2) not null default 0 check (tax_amount >= 0),
  line_total       numeric(12,2) not null check (line_total >= 0),
  unique (tenant_id, id),
  unique (invoice_id, line_no),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id),
  foreign key (tenant_id, service_id) references services (tenant_id, id),
  check (line_type <> 'service' or service_id is not null)
);

create table payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete restrict,
  billing_profile_id  uuid not null,
  receipt_no          text not null,
  fiscal_year         text not null,
  patient_id          uuid,
  amount              numeric(12,2) not null check (amount <> 0),
  cash_amount         numeric(12,2) not null default 0,
  online_amount       numeric(12,2) not null default 0,
  online_channel      text check (online_channel in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')),
  reference           text check (length(reference) <= 80),
  received_by         uuid not null,
  received_at         timestamptz not null default now(),
  posting_id          uuid not null,
  unique (tenant_id, id),
  unique (tenant_id, billing_profile_id, fiscal_year, receipt_no),
  foreign key (tenant_id, billing_profile_id) references billing_profiles (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, received_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  -- HRestroSewa's sign-agreement rule: the legs add up and share the amount's sign.
  check (cash_amount + online_amount = amount),
  check (sign(cash_amount) in (0, sign(amount)) and sign(online_amount) in (0, sign(amount))),
  check ((online_amount = 0) = (online_channel is null))
);

create table payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  payment_id  uuid not null,
  invoice_id  uuid not null,
  amount      numeric(12,2) not null check (amount <> 0),
  unique (tenant_id, id),
  foreign key (tenant_id, payment_id) references payments (tenant_id, id),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id)
);
create index payment_allocations_invoice on payment_allocations (invoice_id);

-- The journal can now point at patients.
alter table ledger_entries add constraint ledger_entries_patient_fk foreign key (tenant_id, patient_id) references patients (tenant_id, id);

-- ── access ────────────────────────────────────────────────────────────────────
alter table patient_mrn_counters enable row level security;
alter table patients             enable row level security;
alter table patient_allergies    enable row level security;
alter table appointments         enable row level security;
alter table token_counters       enable row level security;
alter table visits               enable row level security;
alter table invoices             enable row level security;
alter table invoice_lines        enable row level security;
alter table payments             enable row level security;
alter table payment_allocations  enable row level security;
-- Patients are edited, never deleted (deleted_at); appointments, visits and tokens change
-- only through the functions below; money documents only through check_in_visit (and,
-- from B7, the other ledger_writer posting RPCs).
revoke all on patient_mrn_counters from service_role;
revoke delete on patients, patient_allergies from service_role;
revoke insert, update, delete on appointments, token_counters, visits from service_role;
revoke insert, update, delete on invoices, invoice_lines, payments, payment_allocations from service_role;
revoke update (mrn, possible_duplicate, created_via) on patients from service_role;

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

create or replace function assert_active_member(p_tenant uuid, p_member uuid)
returns void
language plpgsql stable
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from tenant_members where id = p_member and tenant_id = p_tenant and is_active and deleted_at is null) then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0001';
  end if;
end $$;

-- Book an appointment on an available slot or token session (W-10/W-11). The start must be
-- exactly one that available_slots() offers. Slots: the exclusion constraint settles races.
-- Tokens: capacity is counted under a transaction lock on (doctor, session).
create or replace function book_appointment(
  p_tenant uuid, p_patient uuid, p_doctor uuid, p_start timestamptz, p_service uuid,
  p_source text, p_reason text, p_by_kind text, p_by_id uuid, p_manage_token_hash text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_tz text; v_status text; v_day date; v_slot record; v_set tenant_settings; v_id uuid; v_n integer;
begin
  select timezone into v_tz from tenants where id = p_tenant and status = 'active';
  if v_tz is null then raise exception 'TENANT_NOT_ACTIVE' using errcode = 'P0001'; end if;
  if p_by_kind = 'member' then perform assert_active_member(p_tenant, p_by_id); end if;
  if not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  select * into v_set from tenant_settings where tenant_id = p_tenant;
  v_day := (p_start at time zone v_tz)::date;
  if p_start <= now() then raise exception 'SLOT_IN_PAST' using errcode = 'P0001'; end if;
  if v_day > (now() at time zone v_tz)::date + v_set.booking_window_days then
    raise exception 'BEYOND_BOOKING_WINDOW' using errcode = 'P0001';
  end if;
  if p_by_kind <> 'member' and p_start < now() + make_interval(mins => v_set.min_notice_minutes) then
    raise exception 'TOO_SHORT_NOTICE' using errcode = 'P0001';
  end if;
  select * into v_slot from available_slots(p_tenant, p_doctor, v_day, v_day) s where s.slot_start = p_start limit 1;
  if v_slot.slot_start is null then raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001'; end if;
  if p_service is not null and not exists (select 1 from services where id = p_service and tenant_id = p_tenant and is_active) then
    raise exception 'SERVICE_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_slot.mode = 'token' then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant::text || p_doctor::text || p_start::text, 0));
    select count(*) into v_n from appointments
     where tenant_id = p_tenant and doctor_member_id = p_doctor and mode = 'token'
       and scheduled_range = tstzrange(v_slot.slot_start, v_slot.slot_end)
       and status in ('requested', 'confirmed', 'checked_in', 'in_consultation');
    if v_n >= v_slot.capacity then raise exception 'SESSION_FULL' using errcode = 'P0001'; end if;
  end if;

  v_status := case when p_by_kind = 'member' or v_set.auto_confirm_online then 'confirmed' else 'requested' end;
  begin
    insert into appointments (tenant_id, patient_id, doctor_member_id, service_id, mode, appointment_date, scheduled_range,
                              source, booked_by_kind, booked_by_id, status, reason_for_visit, manage_token_hash)
    values (p_tenant, p_patient, p_doctor, p_service, v_slot.mode, v_day, tstzrange(v_slot.slot_start, v_slot.slot_end),
            p_source, p_by_kind, p_by_id, v_status, nullif(btrim(p_reason), ''), p_manage_token_hash)
    returning id into v_id;
  exception when exclusion_violation then
    if sqlerrm like '%appointments_patient_overlap%' then raise exception 'PATIENT_ALREADY_BOOKED' using errcode = 'P0001'; end if;
    raise exception 'SLOT_TAKEN' using errcode = 'P0001';
  end;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, case when p_by_kind = 'member' then 'member' else 'guest_token' end, p_by_id, 'appointment.book', 'appointment', v_id::text, 'success',
          jsonb_build_object('doctor', p_doctor, 'start', p_start, 'mode', v_slot.mode, 'source', p_source));
  return v_id;
end $$;

-- Confirm / cancel / no-show. Check-in and the queue move the rest (the trigger guards all).
create or replace function set_appointment_status(
  p_tenant uuid, p_appointment uuid, p_status text, p_reason text, p_by_kind text, p_by_id uuid
) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_a appointments;
begin
  if p_status not in ('confirmed', 'cancelled', 'no_show') then raise exception 'ILLEGAL_TRANSITION' using errcode = 'P0001'; end if;
  if p_by_kind = 'member' then perform assert_active_member(p_tenant, p_by_id); end if;
  select * into v_a from appointments where id = p_appointment and tenant_id = p_tenant for update;
  if v_a.id is null then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_status = 'cancelled' and coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if p_status = 'no_show' and lower(v_a.scheduled_range) > now() then raise exception 'NOT_YET_DUE' using errcode = 'P0001'; end if;
  update appointments
     set status = p_status,
         cancel_reason = case when p_status = 'cancelled' then btrim(p_reason) end,
         cancelled_at = case when p_status = 'cancelled' then now() end,
         cancelled_by_kind = case when p_status = 'cancelled' then p_by_kind end
   where id = p_appointment;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, reason)
  values (p_tenant, case when p_by_kind = 'member' then 'member' else 'guest_token' end, p_by_id, 'appointment.' || p_status,
          'appointment', p_appointment::text, 'success', nullif(btrim(p_reason), ''));
end $$;

-- Queue moves (W-13). The doctor calls the next token and finishes; the desk can cancel a
-- waiting visit (a paid fee is refunded through billing, B7).
create or replace function move_visit(p_tenant uuid, p_visit uuid, p_to text, p_reason text, p_by uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v visits; v_billing text;
begin
  perform assert_active_member(p_tenant, p_by);
  select * into v from visits where id = p_visit and tenant_id = p_tenant for update;
  if v.id is null then raise exception 'VISIT_NOT_FOUND' using errcode = 'P0001'; end if;
  select consultation_billing_point into v_billing from tenant_settings where tenant_id = p_tenant;
  if p_to = 'with_doctor' and v.status = 'waiting' then
    update visits set status = 'with_doctor', called_at = now() where id = p_visit;
    update appointments set status = 'in_consultation' where id = v.appointment_id and status = 'checked_in';
  elsif p_to = 'waiting' and v.status = 'with_doctor' then
    update visits set status = 'waiting', called_at = null where id = p_visit;   -- not in the room: back in line
    update appointments set status = 'checked_in' where id = v.appointment_id and status = 'in_consultation';
  elsif p_to = 'done' and v.status = 'with_doctor' then
    update visits set status = case when v_billing = 'checkout' then 'awaiting_billing' else 'closed' end,
                      closed_at = case when v_billing = 'checkout' then null else now() end,
                      closed_by = case when v_billing = 'checkout' then null else p_by end
     where id = p_visit;
    update appointments set status = 'completed' where id = v.appointment_id and status in ('checked_in', 'in_consultation');
  elsif p_to = 'cancelled' and v.status = 'waiting' then
    if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
    update visits set status = 'cancelled', cancel_reason = btrim(p_reason), closed_at = now(), closed_by = p_by where id = p_visit;
    update appointments set status = 'cancelled', cancel_reason = btrim(p_reason), cancelled_at = now(), cancelled_by_kind = 'member'
     where id = v.appointment_id and status = 'checked_in';
  else
    raise exception 'ILLEGAL_TRANSITION: % -> %', v.status, p_to using errcode = 'P0001';
  end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, reason)
  values (p_tenant, 'member', p_by, 'visit.' || p_to, 'visit', p_visit::text, 'success', nullif(btrim(p_reason), ''));
end $$;

-- Check a patient in (W-12): token, visit, and, when the clinic charges at registration, the
-- OPD fee bill and its payment, each its own posting in the journal. ONE transaction: no
-- token without its bill, no bill without its journal. Idempotent on p_idempotency_key.
create or replace function check_in_visit(
  p_tenant uuid, p_idempotency_key uuid, p_patient uuid, p_doctor uuid, p_appointment uuid, p_service uuid,
  p_discount numeric, p_cash numeric, p_online numeric, p_channel text, p_reference text,
  p_by uuid, p_session_level text, p_device uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_tz text; v_today date; v_set tenant_settings; v_appt appointments; v_visit uuid; v_token integer;
  v_bp billing_profiles; v_price numeric; v_desc text; v_tax_cat text; v_disc numeric := round(coalesce(p_discount, 0), 2);
  v_net numeric; v_tax numeric; v_total numeric; v_cash numeric := round(coalesce(p_cash, 0), 2); v_online numeric := round(coalesce(p_online, 0), 2);
  v_paid numeric; v_due numeric; v_inv uuid; v_inv_no text; v_fy text; v_n bigint; v_post uuid; v_replayed boolean;
  v_pay uuid; v_rcpt text; v_entries jsonb; v_existing visits;
begin
  if p_idempotency_key is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'P0001'; end if;
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);

  -- A retry of the same check-in returns what the first one did.
  select * into v_existing from visits where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return (select jsonb_build_object('visit_id', v_existing.id, 'token_no', v_existing.token_no, 'replayed', true,
              'invoice_id', i.id, 'invoice_no', i.invoice_no, 'total', i.total,
              'paid', coalesce((select sum(a.amount) from payment_allocations a where a.invoice_id = i.id), 0))
              from (select 1) x left join invoices i on i.visit_id = v_existing.id);
  end if;

  select timezone into v_tz from tenants where id = p_tenant and status = 'active';
  if v_tz is null then raise exception 'TENANT_NOT_ACTIVE' using errcode = 'P0001'; end if;
  v_today := (now() at time zone v_tz)::date;
  select * into v_set from tenant_settings where tenant_id = p_tenant;
  if not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if not exists (select 1 from doctor_profiles dp join tenant_members m on m.id = dp.member_id and m.is_active
                  where dp.member_id = p_doctor and dp.tenant_id = p_tenant) then
    raise exception 'DOCTOR_NOT_FOUND' using errcode = 'P0001';
  end if;

  if p_appointment is not null then
    select * into v_appt from appointments where id = p_appointment and tenant_id = p_tenant for update;
    if v_appt.id is null then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0001'; end if;
    if v_appt.patient_id <> p_patient or v_appt.doctor_member_id <> p_doctor then raise exception 'APPOINTMENT_MISMATCH' using errcode = 'P0001'; end if;
    if v_appt.appointment_date <> v_today then raise exception 'APPOINTMENT_NOT_TODAY' using errcode = 'P0001'; end if;
    if v_appt.status <> 'confirmed' then raise exception 'APPOINTMENT_NOT_CONFIRMED' using errcode = 'P0001'; end if;
    update appointments set status = 'checked_in' where id = p_appointment;
  end if;

  insert into token_counters as t (tenant_id, doctor_member_id, visit_date, next_token) values (p_tenant, p_doctor, v_today, 2)
  on conflict (tenant_id, doctor_member_id, visit_date) do update set next_token = t.next_token + 1
  returning next_token - 1 into v_token;
  begin
    insert into visits (tenant_id, patient_id, doctor_member_id, service_id, appointment_id, visit_date, token_no, checked_in_by, idempotency_key)
    values (p_tenant, p_patient, p_doctor, p_service, p_appointment, v_today, v_token, p_by, p_idempotency_key)
    returning id into v_visit;
  exception when unique_violation then
    if sqlerrm like '%visits_one_live%' then raise exception 'ALREADY_CHECKED_IN' using errcode = 'P0001'; end if;
    raise;
  end;

  -- ── the OPD fee, when the clinic charges at registration ──
  if v_set.consultation_billing_point = 'check_in' then
    if p_service is null then raise exception 'SERVICE_REQUIRED' using errcode = 'P0001'; end if;
    select coalesce(ds.price_override, case when s.kind = 'consultation' then dp.consultation_fee end, s.price_npr), s.name, s.tax_category
      into v_price, v_desc, v_tax_cat
      from services s
      join doctor_profiles dp on dp.member_id = p_doctor and dp.tenant_id = p_tenant
      left join doctor_services ds on ds.member_id = p_doctor and ds.service_id = s.id
     where s.id = p_service and s.tenant_id = p_tenant and s.is_active;
    if v_desc is null then raise exception 'SERVICE_NOT_FOUND' using errcode = 'P0001'; end if;
    if v_disc < 0 or v_disc > v_price then raise exception 'BAD_DISCOUNT' using errcode = 'P0001'; end if;
    if v_price > 0 and v_disc * 100 / v_price > v_set.max_discount_pct_without_reauth then
      raise exception 'DISCOUNT_NEEDS_APPROVAL' using errcode = 'P0001';
    end if;
    v_net := v_price - v_disc;
    v_tax := case when v_tax_cat = 'vat13' then round(v_net * 0.13, 2) else 0 end;
    v_total := v_net + v_tax;
    if v_cash < 0 or v_online < 0 then raise exception 'BAD_PAYMENT' using errcode = 'P0001'; end if;
    if v_online > 0 and p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other') then
      raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001';
    end if;
    v_paid := v_cash + v_online;
    if v_paid > v_total then raise exception 'OVERPAYMENT' using errcode = 'P0001'; end if;
    v_due := v_total - v_paid;
    if v_due > 0 then
      if not v_set.allow_credit then raise exception 'PAYMENT_REQUIRED' using errcode = 'P0001'; end if;
      if v_due + coalesce((select sum(i.total) - coalesce(sum((select sum(a.amount) from payment_allocations a where a.invoice_id = i.id)), 0)
                            from invoices i where i.tenant_id = p_tenant and i.patient_id = p_patient and i.status = 'issued'), 0)
         > v_set.credit_limit_per_patient then
        raise exception 'CREDIT_LIMIT' using errcode = 'P0001';
      end if;
    end if;

    if v_total > 0 then
      select * into v_bp from billing_profiles
       where tenant_id = p_tenant and is_active and (id = v_set.default_billing_profile_id or (v_set.default_billing_profile_id is null and is_default))
       order by (id = v_set.default_billing_profile_id) desc nulls last limit 1;
      if v_bp.id is null then raise exception 'NO_BILLING_PROFILE' using errcode = 'P0001'; end if;

      v_inv := gen_random_uuid();
      select b.posting_id, b.replayed into v_post, v_replayed
        from begin_posting(p_tenant, md5(p_idempotency_key::text || ':invoice')::uuid, 'invoice', v_inv, p_by, p_session_level, p_device) b;
      if v_replayed then raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001'; end if;
      select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'invoice', v_bp.id) d;
      v_inv_no := case when v_bp.invoice_prefix = '' then '' else v_bp.invoice_prefix || '-' end || lpad(v_n::text, v_bp.invoice_pad, '0');
      insert into invoices (id, tenant_id, billing_profile_id, invoice_no, fiscal_year, visit_id, patient_id, source,
                            subtotal, discount_total, taxable_amount, tax_total, total, issued_by, posting_id)
      values (v_inv, p_tenant, v_bp.id, v_inv_no, v_fy, v_visit, p_patient, 'visit',
              v_price, v_disc, case when v_tax > 0 then v_net else 0 end, v_tax, v_total, p_by, v_post);
      insert into invoice_lines (tenant_id, invoice_id, line_no, line_type, service_id, description, qty, unit_price, discount_amount,
                                 tax_rate, tax_amount, line_total)
      values (p_tenant, v_inv, 1, 'service', p_service, v_desc, 1, v_price, v_disc,
              case when v_tax > 0 then 13 else 0 end, v_tax, v_total);
      v_entries := jsonb_build_array(
        jsonb_build_object('account', 'AR_PATIENTS', 'debit', v_total, 'patient_id', p_patient, 'memo', 'OPD ' || v_inv_no),
        jsonb_build_object('account', 'REV_SERVICES', 'credit', v_net, 'memo', v_desc));
      if v_tax > 0 then v_entries := v_entries || jsonb_build_object('account', 'TAX_PAYABLE', 'credit', v_tax); end if;
      perform post_journal(p_tenant, v_post, v_entries);

      if v_paid > 0 then
        v_pay := gen_random_uuid();
        select b.posting_id, b.replayed into v_post, v_replayed
          from begin_posting(p_tenant, md5(p_idempotency_key::text || ':payment')::uuid, 'payment', v_pay, p_by, p_session_level, p_device) b;
        if v_replayed then raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001'; end if;
        select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'receipt', v_bp.id) d;
        v_rcpt := 'R-' || lpad(v_n::text, v_bp.invoice_pad, '0');
        insert into payments (id, tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, amount, cash_amount, online_amount,
                              online_channel, reference, received_by, posting_id)
        values (v_pay, p_tenant, v_bp.id, v_rcpt, v_fy, p_patient, v_paid, v_cash, v_online,
                case when v_online > 0 then p_channel end, nullif(btrim(p_reference), ''), p_by, v_post);
        insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values (p_tenant, v_pay, v_inv, v_paid);
        v_entries := jsonb_build_array(jsonb_build_object('account', 'AR_PATIENTS', 'credit', v_paid, 'patient_id', p_patient, 'memo', v_rcpt));
        if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'debit', v_cash, 'channel', 'cash'); end if;
        if v_online > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'debit', v_online, 'channel', p_channel); end if;
        perform post_journal(p_tenant, v_post, v_entries);
      end if;
    end if;
  end if;

  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'visit.check_in', 'visit', v_visit::text, 'success',
          jsonb_build_object('token', v_token, 'doctor', p_doctor, 'invoice_no', v_inv_no, 'total', v_total, 'paid', v_paid));
  return jsonb_build_object('visit_id', v_visit, 'token_no', v_token, 'replayed', false, 'invoice_id', v_inv, 'invoice_no', v_inv_no,
                            'receipt_no', v_rcpt, 'total', coalesce(v_total, 0), 'paid', coalesce(v_paid, 0), 'due', coalesce(v_due, 0));
end $$;

-- ── ownership and privileges ──────────────────────────────────────────────────
-- check_in_visit writes the journal, so it is a posting RPC owned by ledger_writer (D-39).
grant select on tenant_members, tenant_settings, patients, doctor_profiles, services, doctor_services to ledger_writer;
grant select, update on appointments to ledger_writer;
grant select, insert, update on token_counters to ledger_writer;
grant select, insert on visits, invoices, invoice_lines, payments, payment_allocations to ledger_writer;
grant execute on function assert_active_member(uuid, uuid) to ledger_writer;
grant create on schema public to ledger_writer;
alter function check_in_visit(uuid, uuid, uuid, uuid, uuid, uuid, numeric, numeric, numeric, text, text, uuid, text, uuid) owner to ledger_writer;
revoke create on schema public from ledger_writer;

revoke all on function patients_stamp() from public, anon, authenticated, service_role;
revoke all on function patients_mrn_fixed() from public, anon, authenticated, service_role;
revoke all on function appointments_status_guard() from public, anon, authenticated, service_role;
revoke all on function assert_active_member(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function search_patients(uuid, text, integer) from public, anon, authenticated;
revoke all on function book_appointment(uuid, uuid, uuid, timestamptz, uuid, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function set_appointment_status(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function move_visit(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function check_in_visit(uuid, uuid, uuid, uuid, uuid, uuid, numeric, numeric, numeric, text, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function search_patients(uuid, text, integer) to service_role;
grant execute on function book_appointment(uuid, uuid, uuid, timestamptz, uuid, text, text, text, uuid, text) to service_role;
grant execute on function set_appointment_status(uuid, uuid, text, text, text, uuid) to service_role;
grant execute on function move_visit(uuid, uuid, text, text, uuid) to service_role;
grant execute on function check_in_visit(uuid, uuid, uuid, uuid, uuid, uuid, numeric, numeric, numeric, text, text, uuid, text, uuid) to service_role;
