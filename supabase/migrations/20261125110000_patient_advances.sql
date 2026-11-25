-- =============================================================================
-- 0058 PATIENT ADVANCES (M-52, Phase 2): money a patient leaves with the clinic before a
-- procedure or stay, used against their later bills.
--   Deposit  (patient_advances, "AD-" receipt): Dr CASH / BANK, Cr PATIENT_ADVANCES.
--   Use      (a payment whose leg is the advance): Dr PATIENT_ADVANCES, Cr AR_PATIENTS.
--   Refund   (patient_advances, negative):       Dr PATIENT_ADVANCES, Cr CASH / BANK.
-- A check-in or counter sale for a patient with an advance takes the unpaid part from it
-- automatically, so a clinic that allows no dues can still bill against a deposit. A void
-- puts the advance back. The books check compares deposits less use with the journal.
-- Function bodies marked "as in 00xx" are copies of the current versions with only the
-- advance changes. Decision D-139.
-- =============================================================================

-- ── payments get a third leg: the patient's advance ──────────────────────────
alter table payments add column advance_amount numeric(12,2) not null default 0;
alter table payments drop constraint payments_check, drop constraint payments_check1;
alter table payments add constraint payments_legs_sum check (cash_amount + online_amount + advance_amount = amount);
alter table payments add constraint payments_legs_sign check (
  sign(cash_amount) in (0, sign(amount)) and sign(online_amount) in (0, sign(amount)) and sign(advance_amount) in (0, sign(amount)));

-- ── deposits and refunds ─────────────────────────────────────────────────────
create table patient_advances (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete restrict,
  billing_profile_id  uuid not null,
  receipt_no          text not null,
  fiscal_year         text not null,
  patient_id          uuid not null,
  kind                text not null check (kind in ('deposit', 'refund')),
  amount              numeric(12,2) not null check (amount <> 0),
  cash_amount         numeric(12,2) not null default 0,
  online_amount       numeric(12,2) not null default 0,
  online_channel      text check (online_channel in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')),
  reference           text check (length(reference) <= 80),
  note                text check (length(note) <= 200),
  received_by         uuid not null,
  received_at         timestamptz not null default now(),
  posting_id          uuid not null,
  unique (tenant_id, id),
  unique (tenant_id, billing_profile_id, fiscal_year, receipt_no),
  foreign key (tenant_id, billing_profile_id) references billing_profiles (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, received_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  check ((kind = 'deposit') = (amount > 0)),
  check (cash_amount + online_amount = amount),
  check (sign(cash_amount) in (0, sign(amount)) and sign(online_amount) in (0, sign(amount))),
  check ((online_amount = 0) = (online_channel is null))
);
create index patient_advances_patient on patient_advances (tenant_id, patient_id, received_at);
create index payments_patient_advance on payments (tenant_id, patient_id) where advance_amount <> 0;
alter table patient_advances enable row level security;
revoke insert, update, delete on patient_advances from service_role;
create trigger patient_advances_no_update before update or delete on patient_advances for each row execute function forbid_mutation();

-- What the clinic holds for the patient: deposits less refunds less what bills have used
-- (a void gives its share back, as a negative use).
create or replace function patient_advance_balance(p_tenant uuid, p_patient uuid)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce((select sum(amount) from patient_advances where tenant_id = p_tenant and patient_id = p_patient), 0)
       - coalesce((select sum(advance_amount) from payments where tenant_id = p_tenant and patient_id = p_patient and advance_amount <> 0), 0);
$$;

-- The same, holding the patient's advance lock for the rest of the transaction, so two
-- bills can't spend one deposit twice.
create or replace function patient_advance_locked(p_tenant uuid, p_patient uuid)
returns numeric
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if p_patient is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('advance:' || p_patient::text, 0));
  return patient_advance_balance(p_tenant, p_patient);
end $$;

-- Internal (ledger_writer only): pay open bills from the advance, oldest first, one payment
-- per billing profile; p_invoice limits it to one bill. Returns the amount used.
create or replace function apply_patient_advance(
  p_tenant uuid, p_key uuid, p_patient uuid, p_invoice uuid, p_max numeric, p_by uuid, p_session_level text, p_device uuid
) returns numeric
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_left numeric; v_used numeric := 0; g record; b record; v_bp billing_profiles; v_pay uuid; v_post uuid; v_replayed boolean;
  v_fy text; v_n bigint; v_rcpt text; v_amt numeric; v_take numeric;
begin
  v_left := least(round(coalesce(p_max, 0), 2), patient_advance_locked(p_tenant, p_patient));
  if v_left <= 0 then return 0; end if;
  for g in select o.billing_profile_id, sum(o.outstanding) owed, min(o.issued_at) first_at
             from patient_open_bills(p_tenant, p_patient) o where p_invoice is null or o.invoice_id = p_invoice
            group by o.billing_profile_id order by min(o.issued_at) loop
    exit when v_left <= 0;
    v_amt := least(v_left, g.owed);
    v_pay := gen_random_uuid();
    select bp.posting_id, bp.replayed into v_post, v_replayed
      from begin_posting(p_tenant, md5(p_key::text || ':advance:' || g.billing_profile_id::text)::uuid, 'payment', v_pay, p_by, p_session_level, p_device) bp;
    if v_replayed then raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001'; end if;
    select * into v_bp from billing_profiles where id = g.billing_profile_id;
    select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'receipt', v_bp.id) d;
    v_rcpt := 'R-' || lpad(v_n::text, v_bp.invoice_pad, '0');
    insert into payments (id, tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, amount, cash_amount, online_amount, advance_amount,
                          online_channel, reference, received_by, posting_id)
    values (v_pay, p_tenant, v_bp.id, v_rcpt, v_fy, p_patient, v_amt, 0, 0, v_amt, null, 'from advance', p_by, v_post);
    v_take := v_amt;
    for b in select * from patient_open_bills(p_tenant, p_patient) o
              where o.billing_profile_id = g.billing_profile_id and (p_invoice is null or o.invoice_id = p_invoice) loop
      exit when v_take <= 0;
      insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values (p_tenant, v_pay, b.invoice_id, least(v_take, b.outstanding));
      v_take := v_take - least(v_take, b.outstanding);
    end loop;
    perform post_journal(p_tenant, v_post, jsonb_build_array(
      jsonb_build_object('account', 'PATIENT_ADVANCES', 'debit', v_amt, 'patient_id', p_patient, 'memo', v_rcpt),
      jsonb_build_object('account', 'AR_PATIENTS', 'credit', v_amt, 'patient_id', p_patient, 'memo', v_rcpt)));
    v_left := v_left - v_amt; v_used := v_used + v_amt;
  end loop;
  return v_used;
end $$;

-- Take an advance (deposit) or give one back (refund). Needs manage_billing or pharmacy_sell;
-- a refund needs manage_billing and a reason, and can't exceed what is held.
create or replace function record_patient_advance(
  p_tenant uuid, p_idempotency_key uuid, p_patient uuid, p_kind text, p_cash numeric, p_online numeric, p_channel text,
  p_reference text, p_note text, p_by uuid, p_session_level text, p_device uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_set tenant_settings; v_bp billing_profiles; v_fy text; v_n bigint; v_no text;
  v_cash numeric := round(coalesce(p_cash, 0), 2); v_online numeric := round(coalesce(p_online, 0), 2); v_amt numeric; v_sign integer; v_entries jsonb; v_bal numeric;
begin
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if p_kind not in ('deposit', 'refund') then raise exception 'BAD_KIND' using errcode = 'P0001'; end if;
  if p_kind = 'deposit' and not (has_key(p_by, 'manage_billing') or has_key(p_by, 'pharmacy_sell')) then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if p_kind = 'refund' and not has_key(p_by, 'manage_billing') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if p_kind = 'refund' and length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if v_cash < 0 or v_online < 0 or v_cash + v_online <= 0 then raise exception 'BAD_AMOUNT' using errcode = 'P0001'; end if;
  if v_online > 0 and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  if not exists (select 1 from tenants where id = p_tenant and status = 'active') then raise exception 'TENANT_NOT_ACTIVE' using errcode = 'P0001'; end if;
  if not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant and deleted_at is null) then raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001'; end if;
  v_bal := patient_advance_locked(p_tenant, p_patient);
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'patient_advance', v_id, p_by, p_session_level, p_device) b;
  if v_replayed then
    return (select jsonb_build_object('advance_id', a.id, 'receipt_no', a.receipt_no, 'amount', a.amount, 'balance', patient_advance_balance(p_tenant, p_patient), 'replayed', true)
              from patient_advances a where a.posting_id = v_post);
  end if;
  v_amt := v_cash + v_online;
  if p_kind = 'refund' and v_amt > v_bal then raise exception 'MORE_THAN_HELD' using errcode = 'P0001'; end if;
  v_sign := case when p_kind = 'deposit' then 1 else -1 end;
  select * into v_set from tenant_settings where tenant_id = p_tenant;
  select * into v_bp from billing_profiles where tenant_id = p_tenant and is_active
   order by (id = v_set.default_billing_profile_id) desc nulls last, is_default desc limit 1;
  if v_bp.id is null then raise exception 'NO_BILLING_PROFILE' using errcode = 'P0001'; end if;
  select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'advance', v_bp.id) d;
  v_no := 'AD-' || lpad(v_n::text, v_bp.invoice_pad, '0');
  insert into patient_advances (id, tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, kind, amount, cash_amount, online_amount, online_channel,
                                reference, note, received_by, posting_id)
  values (v_id, p_tenant, v_bp.id, v_no, v_fy, p_patient, p_kind, v_sign * v_amt, v_sign * v_cash, v_sign * v_online, case when v_online > 0 then p_channel end,
          nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(left(coalesce(p_note, ''), 200)), ''), p_by, v_post);
  v_entries := jsonb_build_array(jsonb_build_object('account', 'PATIENT_ADVANCES', case when v_sign > 0 then 'credit' else 'debit' end, v_amt, 'patient_id', p_patient, 'memo', v_no));
  if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', case when v_sign > 0 then 'debit' else 'credit' end, v_cash, 'channel', 'cash', 'memo', v_no); end if;
  if v_online > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', case when v_sign > 0 then 'debit' else 'credit' end, v_online, 'channel', p_channel, 'memo', v_no); end if;
  perform post_journal(p_tenant, v_post, v_entries);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, patient_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'advance.' || p_kind, 'patient', p_patient::text, p_patient, 'success',
          case when p_kind = 'refund' then btrim(p_note) end, jsonb_build_object('receipt', v_no, 'amount', v_amt));
  return jsonb_build_object('advance_id', v_id, 'receipt_no', v_no, 'amount', v_sign * v_amt, 'balance', v_bal + v_sign * v_amt, 'replayed', false);
end $$;

-- Pay the patient's open bills from their advance (oldest first). p_amount null = as much as
-- possible. Needs manage_billing or pharmacy_sell.
create or replace function use_patient_advance(
  p_tenant uuid, p_idempotency_key uuid, p_patient uuid, p_amount numeric, p_by uuid, p_session_level text, p_device uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_used numeric; v_owed numeric; v_bal numeric;
begin
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not (has_key(p_by, 'manage_billing') or has_key(p_by, 'pharmacy_sell')) then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant and deleted_at is null) then raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_amount is not null and round(p_amount, 2) <= 0 then raise exception 'BAD_AMOUNT' using errcode = 'P0001'; end if;
  if exists (select 1 from postings where tenant_id = p_tenant and idempotency_key in
              (select md5(p_idempotency_key::text || ':advance:' || bp.id::text)::uuid from billing_profiles bp where bp.tenant_id = p_tenant)) then
    return jsonb_build_object('replayed', true, 'balance', patient_advance_balance(p_tenant, p_patient));
  end if;
  v_bal := patient_advance_locked(p_tenant, p_patient);
  if v_bal <= 0 then raise exception 'NO_ADVANCE' using errcode = 'P0001'; end if;
  select coalesce(sum(outstanding), 0) into v_owed from patient_open_bills(p_tenant, p_patient);
  if v_owed <= 0 then raise exception 'NO_DUES' using errcode = 'P0001'; end if;
  if p_amount is not null and round(p_amount, 2) > least(v_bal, v_owed) then raise exception 'MORE_THAN_HELD' using errcode = 'P0001'; end if;
  v_used := apply_patient_advance(p_tenant, p_idempotency_key, p_patient, null, coalesce(round(p_amount, 2), least(v_bal, v_owed)), p_by, p_session_level, p_device);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, patient_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'advance.use', 'patient', p_patient::text, p_patient, 'success', jsonb_build_object('amount', v_used));
  return jsonb_build_object('used', v_used, 'balance', v_bal - v_used, 'replayed', false);
end $$;

-- ── merges carry advances too (M-37) ──────────────────────────────────────────
alter table patient_merge_rows drop constraint patient_merge_rows_tbl_check;
alter table patient_merge_rows add constraint patient_merge_rows_tbl_check check (tbl in ('appointments', 'visits', 'invoices', 'payments', 'sale_returns', 'patient_allergies',
  'vitals', 'encounters', 'prescriptions', 'external_prescriptions', 'care_access_grants', 'patient_advances'));
-- patient_advances is append-only; a merge (or its undo) may move a row between the two records only.
create or replace function patient_advances_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' and new.patient_id is distinct from old.patient_id
     and patient_merge_move_ok(old.tenant_id, old.patient_id, new.patient_id)
     and only_patient_moved(to_jsonb(old), to_jsonb(new)) then
    return new;
  end if;
  raise exception 'APPEND_ONLY' using errcode = 'P0001';
end $$;
revoke all on function patient_advances_guard() from public, anon, authenticated;
drop trigger patient_advances_no_update on patient_advances;
create trigger patient_advances_no_update before update or delete on patient_advances for each row execute function patient_advances_guard();



-- ── check-in: as in 0023, plus the advance ────────────────────────────────────
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
  v_pay uuid; v_rcpt text; v_entries jsonb; v_existing visits; v_adv numeric := 0;
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

  if p_service is not null and not exists (select 1 from services where id = p_service and tenant_id = p_tenant and is_active) then
    raise exception 'SERVICE_NOT_FOUND' using errcode = 'P0001';
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
    if v_online > 0 and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then
      raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001';
    end if;
    v_paid := v_cash + v_online;
    if v_paid > v_total then raise exception 'OVERPAYMENT' using errcode = 'P0001'; end if;
    v_due := v_total - v_paid;
    -- M-52: what the patient's advance covers needs no credit.
    if v_due > 0 then v_adv := least(v_due, patient_advance_locked(p_tenant, p_patient)); end if;
    if v_due - v_adv > 0 then
      if not v_set.allow_credit then raise exception 'PAYMENT_REQUIRED' using errcode = 'P0001'; end if;
      if v_due - v_adv + coalesce((select sum(i.total) - coalesce(sum((select sum(a.amount) from payment_allocations a where a.invoice_id = i.id)), 0)
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
      if v_adv > 0 then v_adv := apply_patient_advance(p_tenant, p_idempotency_key, p_patient, v_inv, v_adv, p_by, p_session_level, p_device); end if;
    end if;
  end if;

  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'visit.check_in', 'visit', v_visit::text, 'success',
          jsonb_build_object('token', v_token, 'doctor', p_doctor, 'invoice_no', v_inv_no, 'total', v_total, 'paid', v_paid, 'from_advance', v_adv));
  return jsonb_build_object('visit_id', v_visit, 'token_no', v_token, 'replayed', false, 'invoice_id', v_inv, 'invoice_no', v_inv_no,
                            'receipt_no', v_rcpt, 'total', coalesce(v_total, 0), 'paid', coalesce(v_paid, 0), 'due', coalesce(v_due, 0) - v_adv, 'from_advance', v_adv);
end $$;


-- ── counter sale: as in 0044, plus the advance ────────────────────────────────
create or replace function issue_counter_sale(
  p_tenant uuid, p_idempotency_key uuid, p_store uuid, p_patient uuid, p_customer_name text, p_customer_phone text,
  p_lines jsonb, p_external_rx jsonb, p_cash numeric, p_online numeric, p_channel text, p_reference text,
  p_by uuid, p_session_level text, p_device uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_set tenant_settings; v_store stores; v_bp billing_profiles; v_inv uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_n bigint;
  v_no text; l jsonb; n integer := 0; v_item inventory_items; v_unit item_units; v_md medicine_details; v_svc services; v_qb numeric; v_line uuid;
  v_gross numeric; v_disc numeric; v_net numeric; v_tax numeric; v_cost numeric; a record; v_rxi prescription_items; v_rx prescriptions;
  v_sub numeric := 0; v_dsum numeric := 0; v_taxable numeric := 0; v_taxsum numeric := 0; v_rev_items numeric := 0; v_rev_svc numeric := 0; v_cogs numeric := 0;
  v_total numeric; v_cash numeric := round(coalesce(p_cash, 0), 2); v_online numeric := round(coalesce(p_online, 0), 2); v_paid numeric; v_due numeric;
  v_ext uuid; v_needs_ext boolean := false; v_entries jsonb; v_pay uuid; v_rcpt text; v_lot item_batches; v_today date; v_pct numeric; v_adv numeric := 0;
begin
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'pharmacy_sell') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_store), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  select * into v_store from stores where id = p_store and tenant_id = p_tenant and is_active and is_sellable;
  if v_store.id is null then raise exception 'STORE_NOT_SELLABLE' using errcode = 'P0001'; end if;
  if not exists (select 1 from tenants where id = p_tenant and status = 'active') then raise exception 'TENANT_NOT_ACTIVE' using errcode = 'P0001'; end if;
  if p_patient is not null and not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  if v_cash < 0 or v_online < 0 then raise exception 'BAD_PAYMENT' using errcode = 'P0001'; end if;
  if v_online > 0 and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_set from tenant_settings where tenant_id = p_tenant;
  v_today := stock_today(p_tenant);

  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'invoice', v_inv, p_by, p_session_level, p_device) b;
  if v_replayed then
    return (select jsonb_build_object('invoice_id', i.id, 'invoice_no', i.invoice_no, 'total', i.total, 'replayed', true) from invoices i where i.posting_id = v_post);
  end if;
  select * into v_bp from billing_profiles where tenant_id = p_tenant and is_active
   order by (id = v_store.billing_profile_id) desc, (id = v_set.default_billing_profile_id) desc, is_default desc limit 1;
  if v_bp.id is null then raise exception 'NO_BILLING_PROFILE' using errcode = 'P0001'; end if;
  select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'invoice', v_bp.id) d;
  v_no := case when v_bp.invoice_prefix = '' then '' else v_bp.invoice_prefix || '-' end || lpad(v_n::text, v_bp.invoice_pad, '0');
  insert into invoices (id, tenant_id, billing_profile_id, invoice_no, fiscal_year, patient_id, customer_name, customer_phone, source, store_id,
                        subtotal, discount_total, taxable_amount, tax_total, total, issued_by, posting_id)
  values (v_inv, p_tenant, v_bp.id, v_no, v_fy, p_patient, nullif(btrim(p_customer_name), ''), nullif(btrim(p_customer_phone), ''), 'counter', p_store,
          0, 0, 0, 0, 0, p_by, v_post);

  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    v_line := gen_random_uuid();
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'BAD_QTY: line %', n using errcode = 'P0001'; end if;
    if coalesce((l->>'discount_pct')::numeric, 0) not between 0 and 100 then raise exception 'BAD_DISCOUNT: line %', n using errcode = 'P0001'; end if;

    if l->>'kind' = 'service' then
      select * into v_svc from services where id = (l->>'service_id')::uuid and tenant_id = p_tenant and is_active;
      if v_svc.id is null then raise exception 'SERVICE_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
      v_gross := round((l->>'qty')::numeric * v_svc.price_npr, 2);
      v_disc := round(v_gross * coalesce((l->>'discount_pct')::numeric, 0) / 100, 2);
      v_net := v_gross - v_disc;
      v_tax := case when v_svc.tax_category = 'vat13' then round(v_net * 0.13, 2) else 0 end;
      insert into invoice_lines (id, tenant_id, invoice_id, line_no, line_type, service_id, description, qty, unit_price, discount_amount, tax_rate, tax_amount, line_total)
      values (v_line, p_tenant, v_inv, n, 'service', v_svc.id, v_svc.name, (l->>'qty')::numeric, v_svc.price_npr, v_disc, case when v_tax > 0 then 13 else 0 end, v_tax, v_net + v_tax);
      v_rev_svc := v_rev_svc + v_net;
    else
      select * into v_item from inventory_items where id = (l->>'item_id')::uuid and tenant_id = p_tenant and is_active and deleted_at is null;
      if v_item.id is null then raise exception 'ITEM_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
      select * into v_unit from item_units where id = (l->>'unit_id')::uuid and item_id = v_item.id and can_sell;
      if v_unit.id is null then raise exception 'UNIT_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
      select * into v_md from medicine_details where item_id = v_item.id;
      if v_md.schedule_class in ('controlled', 'narcotic') then raise exception 'CONTROLLED_BLOCKED: line %', n using errcode = 'P0001'; end if;
      v_rxi := null;
      if nullif(l->>'prescription_item_id', '') is not null then
        if not has_key(p_by, 'dispense_prescription') then raise exception 'NO_DISPENSING_RIGHT' using errcode = 'P0001'; end if;
        select * into v_rxi from prescription_items where id = (l->>'prescription_item_id')::uuid and tenant_id = p_tenant;
        select * into v_rx from prescriptions where id = v_rxi.prescription_id;
        if v_rxi.id is null or v_rx.status <> 'issued' or v_rx.patient_id is distinct from p_patient then raise exception 'RX_NOT_VALID: line %', n using errcode = 'P0001'; end if;
      elsif v_md.requires_prescription then
        if not has_key(p_by, 'sell_prescription_only') then raise exception 'NO_DISPENSING_RIGHT' using errcode = 'P0001'; end if;
        if p_external_rx is null or coalesce(btrim(p_external_rx->>'prescriber_name'), '') = '' then raise exception 'RX_REQUIRED: line %', n using errcode = 'P0001'; end if;
        v_needs_ext := true;
      end if;
      v_qb := round((l->>'qty')::numeric * v_unit.factor_to_base, 3);
      if v_qb <> trunc(v_qb) and not v_item.allow_loose_sale then raise exception 'NO_LOOSE_SALE: line %', n using errcode = 'P0001'; end if;
      insert into invoice_lines (id, tenant_id, invoice_id, line_no, line_type, item_id, unit_id, factor_snapshot, description, qty, unit_price, discount_amount,
                                 tax_rate, tax_amount, line_total, prescription_item_id, substitution_reason)
      values (v_line, p_tenant, v_inv, n, 'item', v_item.id, v_unit.id, v_unit.factor_to_base, v_item.name, (l->>'qty')::numeric, 0, 0, 0, 0, 0,
              v_rxi.id, nullif(btrim(l->>'substitution_reason'), ''));
      v_gross := 0; v_cost := 0;
      if nullif(l->>'batch_id', '') is not null then
        -- A chosen lot (override_batch): it must be sellable here, never expired or blocked.
        if not has_key(p_by, 'override_batch') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
        select * into v_lot from item_batches where id = (l->>'batch_id')::uuid and tenant_id = p_tenant and item_id = v_item.id;
        if v_lot.id is null or v_lot.status <> 'active' or (v_lot.expiry_date is not null and v_lot.expiry_date <= v_today + v_set.min_sale_shelf_days) then
          raise exception 'LOT_NOT_SELLABLE: line %', n using errcode = 'P0001';
        end if;
        perform 1 from stock_balances where tenant_id = p_tenant and store_id = p_store and batch_id = v_lot.id for update;
        insert into invoice_line_allocations (tenant_id, invoice_line_id, item_id, batch_id, store_id, base_qty, unit_price_base, unit_cost_base)
        values (p_tenant, v_line, v_item.id, v_lot.id, p_store, v_qb, v_lot.sale_price_base, v_lot.unit_cost_base);
        perform write_movement(p_tenant, p_store, v_lot.id, v_item.id, -v_qb, 'sale', v_lot.unit_cost_base, v_post, 'invoice', v_inv, v_line, null, p_by);
        v_gross := v_qb * v_lot.sale_price_base; v_cost := v_qb * v_lot.unit_cost_base;
      else
        for a in select * from allocate_stock(p_tenant, p_store, v_item.id, v_qb, 'sale') loop
          insert into invoice_line_allocations (tenant_id, invoice_line_id, item_id, batch_id, store_id, base_qty, unit_price_base, unit_cost_base)
          values (p_tenant, v_line, v_item.id, a.batch_id, p_store, a.qty_base, a.sale_price_base, a.unit_cost_base);
          perform write_movement(p_tenant, p_store, a.batch_id, v_item.id, -a.qty_base, 'sale', a.unit_cost_base, v_post, 'invoice', v_inv, v_line, null, p_by);
          v_gross := v_gross + a.qty_base * a.sale_price_base; v_cost := v_cost + a.qty_base * a.unit_cost_base;
        end loop;
      end if;
      v_gross := round(v_gross, 2); v_cost := round(v_cost, 2);
      v_disc := round(v_gross * coalesce((l->>'discount_pct')::numeric, 0) / 100, 2);
      v_net := v_gross - v_disc;
      v_tax := case when v_item.tax_category = 'vat13' then round(v_net * 0.13, 2) else 0 end;
      update invoice_lines set unit_price = round(v_gross / (l->>'qty')::numeric, 2), discount_amount = v_disc, tax_rate = case when v_tax > 0 then 13 else 0 end,
             tax_amount = v_tax, line_total = v_net + v_tax, cost_total = v_cost
       where id = v_line;
      v_rev_items := v_rev_items + v_net; v_cogs := v_cogs + v_cost;
    end if;
    v_sub := v_sub + v_gross; v_dsum := v_dsum + v_disc; v_taxsum := v_taxsum + v_tax;
    if v_tax > 0 then v_taxable := v_taxable + v_net; end if;
  end loop;

  v_pct := case when v_sub > 0 then v_dsum * 100 / v_sub else 0 end;
  if v_pct > v_set.max_discount_pct_without_reauth and not has_key(p_by, 'apply_discounts') then raise exception 'DISCOUNT_NEEDS_APPROVAL' using errcode = 'P0001'; end if;
  v_total := v_sub - v_dsum + v_taxsum;
  v_paid := v_cash + v_online;
  if v_paid > v_total then raise exception 'OVERPAYMENT' using errcode = 'P0001'; end if;
  v_due := v_total - v_paid;
  -- M-52: what the patient's advance covers needs no credit.
  if v_due > 0 and p_patient is not null then v_adv := least(v_due, patient_advance_locked(p_tenant, p_patient)); end if;
  if v_due - v_adv > 0 then
    if p_patient is null then raise exception 'PATIENT_REQUIRED_FOR_DUE' using errcode = 'P0001'; end if;
    if not v_set.allow_credit or not has_key(p_by, 'allow_credit') then raise exception 'PAYMENT_REQUIRED' using errcode = 'P0001'; end if;
    if v_due - v_adv + coalesce((select sum(i.total) - coalesce(sum((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id)), 0)
                          from invoices i where i.tenant_id = p_tenant and i.patient_id = p_patient and i.status = 'issued' and i.id <> v_inv), 0)
       > v_set.credit_limit_per_patient then
      raise exception 'CREDIT_LIMIT' using errcode = 'P0001';
    end if;
  end if;
  if v_needs_ext then
    insert into external_prescriptions (tenant_id, patient_id, prescriber_name, prescriber_reg_no, facility, rx_date, recorded_by)
    values (p_tenant, p_patient, btrim(p_external_rx->>'prescriber_name'), nullif(btrim(p_external_rx->>'prescriber_reg_no'), ''),
            nullif(btrim(p_external_rx->>'facility'), ''), coalesce(nullif(p_external_rx->>'rx_date', '')::date, v_today), p_by)
    returning id into v_ext;
  end if;
  update invoices set subtotal = v_sub, discount_total = v_dsum, taxable_amount = v_taxable, tax_total = v_taxsum, total = v_total, external_prescription_id = v_ext
   where id = v_inv;

  v_entries := jsonb_build_array(jsonb_build_object('account', 'AR_PATIENTS', 'debit', v_total, 'patient_id', p_patient, 'store_id', p_store, 'memo', v_no));
  if v_rev_items > 0 then v_entries := v_entries || jsonb_build_object('account', 'REV_PHARMACY', 'credit', v_rev_items, 'store_id', p_store, 'memo', v_no); end if;
  if v_rev_svc > 0 then v_entries := v_entries || jsonb_build_object('account', 'REV_SERVICES', 'credit', v_rev_svc, 'store_id', p_store, 'memo', v_no); end if;
  if v_taxsum > 0 then v_entries := v_entries || jsonb_build_object('account', 'TAX_PAYABLE', 'credit', v_taxsum, 'memo', v_no); end if;
  if v_cogs > 0 then
    v_entries := v_entries || jsonb_build_object('account', 'COGS', 'debit', v_cogs, 'store_id', p_store, 'memo', v_no)
                           || jsonb_build_object('account', 'INVENTORY', 'credit', v_cogs, 'store_id', p_store, 'memo', v_no);
  end if;
  if v_total > 0 or v_cogs > 0 then perform post_journal(p_tenant, v_post, v_entries); end if;

  if v_paid > 0 then
    v_pay := gen_random_uuid();
    select b.posting_id, b.replayed into v_post, v_replayed
      from begin_posting(p_tenant, md5(p_idempotency_key::text || ':payment')::uuid, 'payment', v_pay, p_by, p_session_level, p_device) b;
    select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'receipt', v_bp.id) d;
    v_rcpt := 'R-' || lpad(v_n::text, v_bp.invoice_pad, '0');
    insert into payments (id, tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, amount, cash_amount, online_amount, online_channel, reference, received_by, posting_id)
    values (v_pay, p_tenant, v_bp.id, v_rcpt, v_fy, p_patient, v_paid, v_cash, v_online, case when v_online > 0 then p_channel end, nullif(btrim(p_reference), ''), p_by, v_post);
    insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values (p_tenant, v_pay, v_inv, v_paid);
    v_entries := jsonb_build_array(jsonb_build_object('account', 'AR_PATIENTS', 'credit', v_paid, 'patient_id', p_patient, 'memo', v_rcpt));
    if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'debit', v_cash, 'channel', 'cash', 'store_id', p_store); end if;
    if v_online > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'debit', v_online, 'channel', p_channel, 'store_id', p_store); end if;
    perform post_journal(p_tenant, v_post, v_entries);
  end if;

  if v_adv > 0 then v_adv := apply_patient_advance(p_tenant, p_idempotency_key, p_patient, v_inv, v_adv, p_by, p_session_level, p_device); end if;

  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'invoice.issue', 'invoice', v_inv::text, 'success',
          jsonb_build_object('no', v_no, 'store', p_store, 'total', v_total, 'paid', v_paid, 'from_advance', v_adv, 'lines', n, 'external_rx', v_ext is not null));
  return jsonb_build_object('invoice_id', v_inv, 'invoice_no', v_no, 'receipt_no', v_rcpt, 'total', v_total, 'paid', v_paid, 'due', v_due - v_adv, 'from_advance', v_adv, 'replayed', false);
end $$;


-- ── void: as in 0045, an advance leg goes back to the advance ──────────────────
create or replace function void_invoice(
  p_tenant uuid, p_idempotency_key uuid, p_invoice uuid, p_reason text,
  p_by uuid, p_session_level text, p_reauth_at timestamptz, p_device uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_inv invoices; v_rev uuid; v_post uuid; v_replayed boolean; a invoice_line_allocations; p record; v_bp billing_profiles; v_fy text; v_n bigint; v_rcpt text;
  v_pay uuid; v_cash numeric; v_online numeric; v_refunded numeric := 0; v_entries jsonb; v_adv numeric; v_d numeric;
begin
  if p_session_level not in ('A2', 'A3') or p_reauth_at is null or p_reauth_at < now() - interval '5 minutes' then raise exception 'REAUTH_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'void_invoices') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_inv from invoices where id = p_invoice and tenant_id = p_tenant for update;
  if v_inv.id is null then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_inv.status = 'void' then
    if exists (select 1 from postings where tenant_id = p_tenant and idempotency_key = p_idempotency_key) then return jsonb_build_object('invoice_id', v_inv.id, 'replayed', true); end if;
    raise exception 'ALREADY_VOID' using errcode = 'P0001';
  end if;
  if business_day(p_tenant, v_inv.issued_at) <> business_day(p_tenant, now()) then raise exception 'NOT_SAME_DAY' using errcode = 'P0001'; end if;
  if exists (select 1 from sale_returns where invoice_id = v_inv.id) then raise exception 'HAS_RETURNS' using errcode = 'P0001'; end if;

  v_rev := reverse_posting(p_tenant, v_inv.posting_id, p_idempotency_key, p_by, p_session_level, p_device, btrim(p_reason));
  for a in select al.* from invoice_line_allocations al join invoice_lines l on l.id = al.invoice_line_id where l.invoice_id = v_inv.id loop
    perform write_movement(p_tenant, a.store_id, a.batch_id, a.item_id, a.base_qty, 'sale_return', a.unit_cost_base, v_rev, 'invoice_void', v_inv.id, a.invoice_line_id, 'void', p_by);
  end loop;

  -- Refund each payment's share of this bill, in the legs it came in.
  select * into v_bp from billing_profiles where id = v_inv.billing_profile_id;
  for p in select pm.id, pm.amount, pm.cash_amount, pm.online_amount, pm.advance_amount, pm.online_channel, sum(pa.amount) share
             from payment_allocations pa join payments pm on pm.id = pa.payment_id
            where pa.invoice_id = v_inv.id group by pm.id having sum(pa.amount) > 0 loop
    -- M-52: refunded in the same legs; an advance leg goes back to the advance.
    v_cash := round(p.share * p.cash_amount / p.amount, 2); v_online := round(p.share * p.online_amount / p.amount, 2); v_adv := round(p.share * p.advance_amount / p.amount, 2);
    v_d := p.share - v_cash - v_online - v_adv;
    if p.advance_amount <> 0 then v_adv := v_adv + v_d; elsif p.online_amount <> 0 then v_online := v_online + v_d; else v_cash := v_cash + v_d; end if;
    v_pay := gen_random_uuid();
    select b.posting_id into v_post from begin_posting(p_tenant, md5(p_idempotency_key::text || ':' || p.id::text)::uuid, 'payment', v_pay, p_by, p_session_level, p_device) b;
    select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'receipt', v_bp.id) d;
    v_rcpt := 'R-' || lpad(v_n::text, v_bp.invoice_pad, '0');
    insert into payments (id, tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, amount, cash_amount, online_amount, advance_amount, online_channel, reference, received_by, posting_id)
    values (v_pay, p_tenant, v_bp.id, v_rcpt, v_fy, v_inv.patient_id, -p.share, -v_cash, -v_online, -v_adv, case when v_online <> 0 then p.online_channel end,
            'void ' || v_inv.invoice_no, p_by, v_post);
    insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values (p_tenant, v_pay, v_inv.id, -p.share);
    v_entries := jsonb_build_array(jsonb_build_object('account', 'AR_PATIENTS', 'debit', p.share, 'patient_id', v_inv.patient_id, 'memo', v_rcpt));
    if v_cash <> 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'credit', v_cash, 'channel', 'cash', 'store_id', v_inv.store_id); end if;
    if v_online <> 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'credit', v_online, 'channel', p.online_channel, 'store_id', v_inv.store_id); end if;
    if v_adv <> 0 then v_entries := v_entries || jsonb_build_object('account', 'PATIENT_ADVANCES', 'credit', v_adv, 'patient_id', v_inv.patient_id, 'memo', v_rcpt); end if;
    perform post_journal(p_tenant, v_post, v_entries);
    v_refunded := v_refunded + p.share;
  end loop;

  update invoices set status = 'void', void_reason = btrim(p_reason), voided_by = p_by, voided_at = now() where id = v_inv.id;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'invoice.void', 'invoice', v_inv.id::text, 'success', btrim(p_reason),
          jsonb_build_object('no', v_inv.invoice_no, 'total', v_inv.total, 'refunded', v_refunded));
  return jsonb_build_object('invoice_id', v_inv.id, 'refunded', v_refunded, 'replayed', false);
end $$;


-- ── finance: as in 0046, advances held, collected vs taken from advance, books check ──
create or replace function finance_report(p_tenant uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare r record; v_bal jsonb := '{}'; a text; v_flow jsonb; v_money jsonb; v_exp jsonb; v_chan jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_PERIOD' using errcode = 'P0001'; end if;
  select * into r from finance_range(p_tenant, p_from, p_to);
  foreach a in array array['CASH', 'BANK', 'AR_PATIENTS', 'INVENTORY', 'INVENTORY_IN_TRANSIT', 'VENDOR_ADVANCES', 'TAX_RECEIVABLE', 'AP_VENDORS', 'TAX_PAYABLE', 'PATIENT_ADVANCES'] loop
    v_bal := v_bal || jsonb_build_object(a, jsonb_build_object(
      'opening', case when a in ('AP_VENDORS', 'TAX_PAYABLE', 'PATIENT_ADVANCES') then -account_balance(p_tenant, a, r.t0) else account_balance(p_tenant, a, r.t0) end,
      'closing', case when a in ('AP_VENDORS', 'TAX_PAYABLE', 'PATIENT_ADVANCES') then -account_balance(p_tenant, a, r.t1) else account_balance(p_tenant, a, r.t1) end));
  end loop;
  -- income/expense flows (credit − debit for income, debit − credit for expenses)
  select coalesce(jsonb_object_agg(code, amt), '{}') into v_flow from (
    select e.account_code code, sum(case when la.type = 'income' then e.credit - e.debit else e.debit - e.credit end) amt
      from ledger_entries e join ledger_accounts la on la.tenant_id = e.tenant_id and la.code = e.account_code
     where e.tenant_id = p_tenant and e.occurred_at >= r.t0 and e.occurred_at < r.t1 and la.type in ('income', 'expense')
     group by 1) f;
  select coalesce(jsonb_agg(jsonb_build_object('code', la.code, 'name', la.name, 'amount', coalesce((v_flow->>la.code)::numeric, 0)) order by la.name), '[]') into v_exp
    from ledger_accounts la where la.tenant_id = p_tenant and la.code like 'EXP\_%' and coalesce((v_flow->>la.code)::numeric, 0) <> 0;
  -- money in and out by what caused it (a reversal counts under what it reverses)
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'cash_in', cash_in, 'cash_out', cash_out, 'bank_in', bank_in, 'bank_out', bank_out) order by kind), '[]') into v_money from (
    select coalesce(o.doc_type, p.doc_type) kind,
           sum(case when e.account_code = 'CASH' then e.debit else 0 end) cash_in, sum(case when e.account_code = 'CASH' then e.credit else 0 end) cash_out,
           sum(case when e.account_code = 'BANK' then e.debit else 0 end) bank_in, sum(case when e.account_code = 'BANK' then e.credit else 0 end) bank_out
      from ledger_entries e join postings p on p.id = e.posting_id left join postings o on o.id = p.reverses_posting_id
     where e.tenant_id = p_tenant and e.account_code in ('CASH', 'BANK') and e.occurred_at >= r.t0 and e.occurred_at < r.t1
     group by 1) m;
  -- online money by channel (net)
  select coalesce(jsonb_object_agg(ch, amt), '{}') into v_chan from (
    select coalesce(channel, 'unspecified') ch, sum(debit - credit) amt from ledger_entries
     where tenant_id = p_tenant and account_code = 'BANK' and occurred_at >= r.t0 and occurred_at < r.t1 group by 1) c;
  return jsonb_build_object('from', p_from, 'to', p_to, 'balances', v_bal,
    'revenue_services', coalesce((v_flow->>'REV_SERVICES')::numeric, 0), 'revenue_pharmacy', coalesce((v_flow->>'REV_PHARMACY')::numeric, 0),
    'other_income', coalesce((v_flow->>'REV_OTHER')::numeric, 0), 'cogs', coalesce((v_flow->>'COGS')::numeric, 0),
    'inventory_loss', coalesce((v_flow->>'INV_LOSS')::numeric, 0), 'inventory_gain', coalesce((v_flow->>'INV_GAIN')::numeric, 0),
    'rounding', coalesce((v_flow->>'ROUNDING')::numeric, 0),
    'expenses', coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(v_exp) x), 0), 'expenses_by_category', v_exp,
    'money', v_money, 'online_by_channel', v_chan);
end $$;

create or replace function daily_summary(p_tenant uuid, p_day date)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare r record;
begin
  select * into r from finance_range(p_tenant, p_day, p_day);
  return jsonb_build_object('day', p_day,
    'bills', (select count(*) from invoices where tenant_id = p_tenant and issued_at >= r.t0 and issued_at < r.t1),
    'voided', (select count(*) from invoices where tenant_id = p_tenant and issued_at >= r.t0 and issued_at < r.t1 and status = 'void'),
    'sales', (select coalesce(sum(total), 0) from invoices where tenant_id = p_tenant and issued_at >= r.t0 and issued_at < r.t1 and status = 'issued'),
    'returns', (select coalesce(sum(total), 0) from sale_returns where tenant_id = p_tenant and created_at >= r.t0 and created_at < r.t1),
    'collected', (select coalesce(sum(cash_amount + online_amount), 0) from payments where tenant_id = p_tenant and received_at >= r.t0 and received_at < r.t1 and amount > 0),
    'refunded', (select coalesce(-sum(cash_amount + online_amount), 0) from payments where tenant_id = p_tenant and received_at >= r.t0 and received_at < r.t1 and amount < 0),
    'advances_in', (select coalesce(sum(amount), 0) from patient_advances where tenant_id = p_tenant and received_at >= r.t0 and received_at < r.t1 and amount > 0),
    'advances_refunded', (select coalesce(-sum(amount), 0) from patient_advances where tenant_id = p_tenant and received_at >= r.t0 and received_at < r.t1 and amount < 0),
    'advances_used', (select coalesce(sum(advance_amount), 0) from payments where tenant_id = p_tenant and received_at >= r.t0 and received_at < r.t1 and advance_amount <> 0),
    'advances_held', -account_balance(p_tenant, 'PATIENT_ADVANCES', r.t1),
    'dues_change', account_balance(p_tenant, 'AR_PATIENTS', r.t1) - account_balance(p_tenant, 'AR_PATIENTS', r.t0),
    'expenses', (select coalesce(sum(amount), 0) from expenses e where tenant_id = p_tenant and recorded_at >= r.t0 and recorded_at < r.t1 and not posting_reversed(e.posting_id)),
    'cash_close', account_balance(p_tenant, 'CASH', r.t1), 'bank_close', account_balance(p_tenant, 'BANK', r.t1));
end $$;

create or replace function verify_finance_integrity(p_tenant uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_checks jsonb := '[]'; v_bad integer := 0; d numeric; j numeric; v_tol numeric;
        v_name text;
begin
  for v_name in select unnest(array['receivables', 'inventory', 'cash', 'bank', 'advances']) loop
    v_tol := 0.01;
    if v_name = 'receivables' then
      select coalesce(sum(invoice_outstanding(id)), 0) into d from invoices where tenant_id = p_tenant and status = 'issued';
      j := account_balance(p_tenant, 'AR_PATIENTS', 'infinity');
    elsif v_name = 'advances' then
      select coalesce(sum(amount), 0) - coalesce((select sum(advance_amount) from payments where tenant_id = p_tenant), 0) into d from patient_advances where tenant_id = p_tenant;
      j := -account_balance(p_tenant, 'PATIENT_ADVANCES', 'infinity');
    elsif v_name = 'inventory' then
      select coalesce(sum(qty_base * unit_cost_base), 0) into d from stock_movements where tenant_id = p_tenant;
      j := account_balance(p_tenant, 'INVENTORY', 'infinity');
      v_tol := 1.00;
    else
      select coalesce(sum(case when v_name = 'cash' then cash_amount else online_amount end), 0) into d from payments where tenant_id = p_tenant;
      d := d + coalesce((select sum(case when v_name = 'cash' then cash_amount else online_amount end) from patient_advances where tenant_id = p_tenant), 0);
      d := d + coalesce((select sum(case when v_name = 'cash' then cash_amount else online_amount end) from other_income i where tenant_id = p_tenant and not posting_reversed(i.posting_id)), 0)
             - coalesce((select sum(case when v_name = 'cash' then cash_amount else online_amount end) from expenses e where tenant_id = p_tenant and not posting_reversed(e.posting_id)), 0)
             - coalesce((select sum(case when v_name = 'cash' then cash_amount else online_amount end) from vendor_payments where tenant_id = p_tenant), 0)
             - coalesce((select sum(case when v_name = 'cash' then paid_cash else paid_online end) from purchase_invoices where tenant_id = p_tenant and status = 'posted'), 0)
             + coalesce((select sum(total) from purchase_returns where tenant_id = p_tenant and settlement = case when v_name = 'cash' then 'cash_refund' else 'online_refund' end), 0)
             + coalesce((select case when v_name = 'cash' then cash_amount else bank_amount end from finance_openings where tenant_id = p_tenant), 0);
      j := account_balance(p_tenant, upper(v_name), 'infinity');
    end if;
    v_checks := v_checks || jsonb_build_object('check', v_name, 'documents', round(d, 2), 'journal', round(j, 2), 'ok', abs(d - j) <= v_tol);
    if abs(d - j) > v_tol then v_bad := v_bad + 1; end if;
  end loop;
  insert into finance_checks (tenant_id, mismatches, checks) values (p_tenant, v_bad, v_checks);
  if v_bad > 0 then
    insert into audit_log (tenant_id, actor_kind, action, outcome, detail)
    values (p_tenant, 'system', 'finance.integrity', 'error', jsonb_build_object('mismatches', v_bad, 'checks', v_checks));
  end if;
  return jsonb_build_object('mismatches', v_bad, 'checks', v_checks);
end $$;


-- ── merge: as in 0057, advances move too ──────────────────────────────────────
create or replace function merge_patients(p_tenant uuid, p_kept uuid, p_merged uuid, p_by uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_kept patients; v_dup patients; v_merge uuid; v_counts jsonb := '{}'::jsonb; v_n int; t text;
  v_tables text[] := array['appointments', 'visits', 'invoices', 'payments', 'sale_returns', 'patient_allergies',
                           'vitals', 'encounters', 'prescriptions', 'external_prescriptions', 'care_access_grants', 'patient_advances'];
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_patients') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if p_kept = p_merged then raise exception 'MERGE_SAME_PATIENT' using errcode = 'P0001'; end if;
  -- Lock both in a fixed order so two merges of the same pair can't interleave.
  perform 1 from patients where tenant_id = p_tenant and id in (p_kept, p_merged) order by id for update;
  select * into v_kept from patients where tenant_id = p_tenant and id = p_kept and deleted_at is null;
  select * into v_dup from patients where tenant_id = p_tenant and id = p_merged and deleted_at is null;
  if v_kept.id is null or v_dup.id is null then raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from visits where tenant_id = p_tenant and patient_id = p_merged and status in ('waiting', 'with_doctor', 'awaiting_billing')) then
    raise exception 'MERGE_LIVE_VISIT' using errcode = 'P0001';
  end if;

  insert into patient_merges (tenant_id, kept_patient_id, merged_patient_id, reason, kept_was_flagged, merged_by)
  values (p_tenant, p_kept, p_merged, nullif(btrim(left(p_reason, 200)), ''), v_kept.possible_duplicate, p_by)
  returning id into v_merge;

  -- Point the duplicate at the kept record first: the locked-table triggers check this pair.
  update patients set merged_into = p_kept, merged_at = now(), deleted_at = now() where id = p_merged;

  foreach t in array v_tables loop
    execute format(
      'with m as (update %1$I set patient_id = $2 where tenant_id = $1 and patient_id = $3 returning id%2$s)
       insert into patient_merge_rows (tenant_id, merge_id, tbl, row_id, status_at_merge) select $1, $4, %3$L, id, %4$s from m',
      t, case when t = 'appointments' then ', status' else '' end, t, case when t = 'appointments' then 'status' else 'null' end)
      using p_tenant, p_kept, p_merged, v_merge;
    get diagnostics v_n = row_count;
    if v_n > 0 then v_counts := v_counts || jsonb_build_object(t, v_n); end if;
  end loop;

  -- The kept record stops warning once no other likely match is left.
  update patients set possible_duplicate = false
   where id = p_kept and possible_duplicate and not exists (select 1 from patient_duplicate_candidates(p_tenant, p_kept));

  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, patient_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, 'patient.merged', 'patient', p_kept::text, p_kept, 'success', nullif(btrim(left(p_reason, 200)), ''),
          jsonb_build_object('merge_id', v_merge, 'merged_patient_id', p_merged, 'merged_mrn', v_dup.mrn, 'kept_mrn', v_kept.mrn, 'moved', v_counts));
  return v_merge;
exception
  when exclusion_violation then raise exception 'MERGE_APPOINTMENT_CLASH' using errcode = 'P0001';
  when unique_violation then raise exception 'MERGE_LIVE_VISIT' using errcode = 'P0001';
end $$;

create or replace function undo_patient_merge(p_tenant uuid, p_merge uuid, p_by uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  m patient_merges; v_counts jsonb := '{}'::jsonb; v_kept_back int := 0; v_n int; t text;
  v_tables text[] := array['appointments', 'visits', 'invoices', 'payments', 'sale_returns', 'patient_allergies',
                           'vitals', 'encounters', 'prescriptions', 'external_prescriptions', 'care_access_grants', 'patient_advances'];
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_patients') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  select * into m from patient_merges where tenant_id = p_tenant and id = p_merge for update;
  if m.id is null then raise exception 'MERGE_NOT_FOUND' using errcode = 'P0001'; end if;
  if m.undone_at is not null then raise exception 'MERGE_ALREADY_UNDONE' using errcode = 'P0001'; end if;
  perform 1 from patients where tenant_id = p_tenant and id in (m.kept_patient_id, m.merged_patient_id) order by id for update;
  -- The kept record was itself merged into a third one since: undo that merge first.
  if not exists (select 1 from patients where id = m.kept_patient_id and deleted_at is null) then
    raise exception 'MERGE_UNDO_LATER_FIRST' using errcode = 'P0001';
  end if;
  if exists (select 1 from patient_merge_rows r join visits v on v.id = r.row_id
              where r.merge_id = m.id and r.tbl = 'visits' and v.status in ('waiting', 'with_doctor', 'awaiting_billing')) then
    raise exception 'MERGE_LIVE_VISIT' using errcode = 'P0001';
  end if;

  foreach t in array v_tables loop
    execute format(
      'update %1$I x set patient_id = $3 from patient_merge_rows r
        where r.tenant_id = $1 and r.merge_id = $4 and r.tbl = %2$L and r.row_id = x.id and x.tenant_id = $1 and x.patient_id = $2%3$s',
      t, t, case when t = 'appointments' then ' and x.status = r.status_at_merge' else '' end)
      using p_tenant, m.kept_patient_id, m.merged_patient_id, m.id;
    get diagnostics v_n = row_count;
    if v_n > 0 then v_counts := v_counts || jsonb_build_object(t, v_n); end if;
  end loop;
  select count(*) into v_kept_back from patient_merge_rows r join appointments a on a.id = r.row_id
   where r.merge_id = m.id and r.tbl = 'appointments' and a.patient_id = m.kept_patient_id;

  -- M-52: the kept record may have spent the merged record's deposit; separating them would leave it owing.
  if patient_advance_balance(p_tenant, m.kept_patient_id) < 0 then raise exception 'MERGE_UNDO_ADVANCE_SPENT' using errcode = 'P0001'; end if;
  update patients set merged_into = null, merged_at = null, deleted_at = null where id = m.merged_patient_id;
  update patients set possible_duplicate = true where id = m.kept_patient_id and m.kept_was_flagged;
  update patient_merges set undone_by = p_by, undone_at = now() where id = m.id;

  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, patient_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, 'patient.merge_undone', 'patient', m.kept_patient_id::text, m.kept_patient_id, 'success', nullif(btrim(left(p_reason, 200)), ''),
          jsonb_build_object('merge_id', m.id, 'merged_patient_id', m.merged_patient_id, 'moved_back', v_counts, 'appointments_kept', v_kept_back));
  return jsonb_build_object('moved_back', v_counts, 'appointments_kept', v_kept_back);
exception
  when exclusion_violation then raise exception 'MERGE_APPOINTMENT_CLASH' using errcode = 'P0001';
  when unique_violation then raise exception 'MERGE_LIVE_VISIT' using errcode = 'P0001';
end $$;


-- ── ownership and privileges ──────────────────────────────────────────────────
grant select, insert on patient_advances to ledger_writer;
grant select on patient_advances to service_role;
grant execute on function patient_advance_balance(uuid, uuid), patient_advance_locked(uuid, uuid) to ledger_writer;
grant create on schema public to ledger_writer;
alter function apply_patient_advance(uuid, uuid, uuid, uuid, numeric, uuid, text, uuid) owner to ledger_writer;
alter function record_patient_advance(uuid, uuid, uuid, text, numeric, numeric, text, text, text, uuid, text, uuid) owner to ledger_writer;
alter function use_patient_advance(uuid, uuid, uuid, numeric, uuid, text, uuid) owner to ledger_writer;
revoke create on schema public from ledger_writer;
grant execute on function apply_patient_advance(uuid, uuid, uuid, uuid, numeric, uuid, text, uuid) to ledger_writer;
revoke all on function apply_patient_advance(uuid, uuid, uuid, uuid, numeric, uuid, text, uuid), patient_advance_locked(uuid, uuid),
                       record_patient_advance(uuid, uuid, uuid, text, numeric, numeric, text, text, text, uuid, text, uuid),
                       use_patient_advance(uuid, uuid, uuid, numeric, uuid, text, uuid), patient_advance_balance(uuid, uuid) from public, anon, authenticated;
grant execute on function record_patient_advance(uuid, uuid, uuid, text, numeric, numeric, text, text, text, uuid, text, uuid),
                          use_patient_advance(uuid, uuid, uuid, numeric, uuid, text, uuid), patient_advance_balance(uuid, uuid) to service_role;
