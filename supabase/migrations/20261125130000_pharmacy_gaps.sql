-- =============================================================================
-- 0060 PHARMACY GAPS (pharmacy track, step 1). Decision D-141.
--  1. Partial dispensing: a prescription line counts as dispensed only when the quantity sold
--     (net of returns, in the medicine's base unit) reaches the prescribed quantity; the
--     dispensing queue shows what is left. A line with no quantity is done after any sale.
--  2. Credit limit: what a patient already owes is counted net of returns and dues collected
--     (invoice_outstanding), at check-in and at the counter. It used to ignore returns.
--  3. A customer return can go into the patient's advance (settlement 'to_advance'): a
--     negative payment whose leg is the advance, Dr AR_PATIENTS / Cr PATIENT_ADVANCES.
-- Bodies marked "as in 00xx" are the current versions with only these changes.
-- =============================================================================

-- What has been dispensed against a prescription line, in base units, net of returns.
create or replace function rx_item_dispensed_base(p_rx_item uuid)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce((select sum(il.qty * coalesce(il.factor_snapshot, 1)) from invoice_lines il join invoices iv on iv.id = il.invoice_id
                    where il.prescription_item_id = p_rx_item and iv.status = 'issued'), 0)
       - coalesce((select sum(r.qty_base) from sale_return_lines r join invoice_line_allocations a on a.id = r.allocation_id
                     join invoice_lines il on il.id = a.invoice_line_id join invoices iv on iv.id = il.invoice_id
                    where il.prescription_item_id = p_rx_item and iv.status = 'issued'), 0);
$$;

create or replace function rx_item_done(p_rx_item uuid, p_quantity numeric)
returns boolean
language sql stable
set search_path = pg_catalog, public
as $$
  select case when coalesce(p_quantity, 0) <= 0 then rx_item_dispensed_base(p_rx_item) > 0
              else rx_item_dispensed_base(p_rx_item) >= p_quantity end;
$$;

alter table sale_returns drop constraint sale_returns_settlement_check;
alter table sale_returns add constraint sale_returns_settlement_check check (settlement in ('refund_cash', 'refund_online', 'reduce_due', 'to_advance'));


-- ── dispensing queue: as in 0044, with what is left per line ─────────────────
create or replace function dispensing_queue(p_tenant uuid, p_member uuid, p_session_level text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_out jsonb;
begin
  perform assert_active_member(p_tenant, p_member);
  if not has_key(p_member, 'dispense_prescription') then
    insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, outcome, reason)
    values (p_tenant, 'member', p_member, p_session_level, 'pharmacy.queue_read', 'denied', 'no_dispensing_right');
    return jsonb_build_object('error', 'NO_DISPENSING_RIGHT');
  end if;
  select coalesce(jsonb_agg(q order by q->>'issued_at' desc), '[]') into v_out from (
    select jsonb_build_object(
      'prescription_id', rx.id, 'rx_number', rx.rx_number, 'issued_at', rx.issued_at, 'notes', rx.notes,
      'doctor', (select display_name from tenant_members where id = rx.doctor_member_id),
      'patient', (select jsonb_build_object('id', p.id, 'mrn', p.mrn, 'full_name', p.full_name, 'sex', p.sex, 'age_years', p.age_years, 'date_of_birth', p.date_of_birth, 'created_at', p.created_at) from patients p where p.id = rx.patient_id),
      'allergies', coalesce((select jsonb_agg(a.allergen) from patient_allergies a where a.patient_id = rx.patient_id and a.removed_at is null), '[]'),
      'items', (select jsonb_agg(jsonb_build_object('id', i.id, 'medicine_text', i.medicine_text, 'strength', i.strength, 'form', i.form, 'dose', i.dose,
                  'frequency', i.frequency, 'duration_days', i.duration_days, 'quantity', i.quantity, 'instructions', i.instructions,
                  'dispensed_base', rx_item_dispensed_base(i.id),
                  'remaining', case when coalesce(i.quantity, 0) > 0 then greatest(i.quantity - rx_item_dispensed_base(i.id), 0) end,
                  'dispensed', rx_item_done(i.id, i.quantity))
                  order by i.line_no) from prescription_items i where i.prescription_id = rx.id)) q
      from prescriptions rx
     where rx.tenant_id = p_tenant and rx.status = 'issued' and rx.issued_at > now() - interval '14 days'
       and exists (select 1 from prescription_items i where i.prescription_id = rx.id
                    and not rx_item_done(i.id, i.quantity))
  ) s(q);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, outcome, detail)
  values (p_tenant, 'member', p_member, p_session_level, 'pharmacy.queue_read', 'success', jsonb_build_object('prescriptions', jsonb_array_length(v_out)));
  return jsonb_build_object('queue', v_out);
end $$;

-- ── check-in: as in 0058, owed counted net of returns ──────────────────────────
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
      if v_due - v_adv + coalesce((select sum(invoice_outstanding(i.id)) from invoices i where i.tenant_id = p_tenant and i.patient_id = p_patient and i.status = 'issued'), 0)
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

-- ── counter sale: as in 0058, owed counted net of returns ──────────────────────
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
    if v_due - v_adv + coalesce((select sum(invoice_outstanding(i.id)) from invoices i where i.tenant_id = p_tenant and i.patient_id = p_patient and i.status = 'issued' and i.id <> v_inv), 0)
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

-- ── customer return: as in 0045, plus 'to_advance' ────────────────────────────
create or replace function post_sale_return(
  p_tenant uuid, p_idempotency_key uuid, p_invoice uuid, p_settlement text, p_channel text, p_reason text, p_lines jsonb,
  p_by uuid, p_session_level text, p_reauth_at timestamptz, p_device uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_inv invoices; v_ret uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_n bigint; v_no text; v_bp billing_profiles;
  l jsonb; a invoice_line_allocations; il invoice_lines; v_lot item_batches; v_item inventory_items; v_qty numeric; v_net numeric; v_tax numeric; v_cost numeric;
  v_to uuid; v_quar uuid; v_today date; v_sum_net numeric := 0; v_sum_tax numeric := 0; v_total numeric; v_entries jsonb; v_pay uuid; v_rcpt text;
  v_restock_cost jsonb := '{}'; k text; n integer := 0; v_gross numeric; v_due_before numeric; v_paid_before numeric;
begin
  if p_session_level not in ('A2', 'A3') or p_reauth_at is null or p_reauth_at < now() - interval '5 minutes' then raise exception 'REAUTH_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'sale_returns') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if p_settlement not in ('refund_cash', 'refund_online', 'reduce_due', 'to_advance') then raise exception 'BAD_SETTLEMENT' using errcode = 'P0001'; end if;
  if p_settlement = 'refund_online' and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select * into v_inv from invoices where id = p_invoice and tenant_id = p_tenant for update;
  if v_inv.id is null then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_inv.status <> 'issued' then raise exception 'INVOICE_VOID' using errcode = 'P0001'; end if;
  if p_settlement = 'to_advance' and v_inv.patient_id is null then raise exception 'PATIENT_REQUIRED_FOR_ADVANCE' using errcode = 'P0001'; end if;

  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'sale_return', v_ret, p_by, p_session_level, p_device) b;
  if v_replayed then
    return (select jsonb_build_object('return_id', r.id, 'return_no', r.return_no, 'total', r.total, 'replayed', true) from sale_returns r where r.posting_id = v_post);
  end if;
  v_due_before := invoice_outstanding(v_inv.id); v_paid_before := invoice_paid(v_inv.id);
  v_today := stock_today(p_tenant);
  select id into v_quar from stores where tenant_id = p_tenant and kind = 'quarantine' and is_active order by created_at limit 1;
  select * into v_bp from billing_profiles where id = v_inv.billing_profile_id;
  select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'sale_return', v_bp.id) d;
  v_no := 'SR-' || lpad(v_n::text, v_bp.invoice_pad, '0');
  insert into sale_returns (id, tenant_id, billing_profile_id, return_no, fiscal_year, invoice_id, patient_id, settlement, online_channel,
                            net_amount, tax_amount, total, reason, posting_id, created_by)
  values (v_ret, p_tenant, v_bp.id, v_no, v_fy, v_inv.id, v_inv.patient_id, p_settlement, case when p_settlement = 'refund_online' then p_channel end,
          0.01, 0, 0.01, btrim(p_reason), v_post, p_by);   -- placeholder until the lines are priced

  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    v_qty := round(coalesce((l->>'qty_base')::numeric, 0), 3);
    if v_qty <= 0 then raise exception 'BAD_QTY: line %', n using errcode = 'P0001'; end if;
    select * into a from invoice_line_allocations where id = (l->>'allocation_id')::uuid and tenant_id = p_tenant;   -- the bill row lock above serialises returns
    select * into il from invoice_lines where id = a.invoice_line_id;
    if a.id is null or il.invoice_id <> v_inv.id then raise exception 'NOT_ON_THIS_BILL: line %', n using errcode = 'P0001'; end if;
    if v_qty > a.base_qty - coalesce((select sum(qty_base) from sale_return_lines where allocation_id = a.id), 0) then
      raise exception 'MORE_THAN_SOLD: line %', n using errcode = 'P0001';
    end if;
    select * into v_lot from item_batches where id = a.batch_id;
    select * into v_item from inventory_items where id = a.item_id;
    v_to := null;
    if l->>'restock' = 'sellable' then
      if v_lot.status <> 'active' or (v_lot.expiry_date is not null and v_lot.expiry_date <= v_today) then raise exception 'CANT_RESTOCK_SELLABLE: line %', n using errcode = 'P0001'; end if;
      if v_item.storage_condition in ('cool_2_8', 'frozen') then raise exception 'COLD_CHAIN_QUARANTINE: line %', n using errcode = 'P0001'; end if;
      v_to := a.store_id;
    elsif l->>'restock' = 'quarantine' then
      if v_quar is null then raise exception 'NO_QUARANTINE_STORE' using errcode = 'P0001'; end if;
      v_to := v_quar;
    elsif coalesce(l->>'restock', '') <> 'none' then
      raise exception 'BAD_RESTOCK: line %', n using errcode = 'P0001';
    end if;
    select sum(x.base_qty * x.unit_price_base) into v_gross from invoice_line_allocations x where x.invoice_line_id = il.id;
    v_net := case when v_gross > 0 then round(v_qty * a.unit_price_base * (il.line_total - il.tax_amount) / v_gross, 2) else 0 end;
    v_tax := round(v_net * il.tax_rate / 100, 2);
    v_cost := round(v_qty * a.unit_cost_base, 2);
    insert into sale_return_lines (tenant_id, return_id, allocation_id, item_id, batch_id, qty_base, restock, to_store_id, net_amount, tax_amount, cost)
    values (p_tenant, v_ret, a.id, a.item_id, a.batch_id, v_qty, l->>'restock', v_to, v_net, v_tax, v_cost);
    if v_to is not null then
      perform write_movement(p_tenant, v_to, a.batch_id, a.item_id, v_qty, 'sale_return', a.unit_cost_base, v_post, 'sale_return', v_ret, null, l->>'restock', p_by);
      v_restock_cost := jsonb_set(v_restock_cost, array[v_to::text], to_jsonb(coalesce((v_restock_cost->>v_to::text)::numeric, 0) + v_qty * a.unit_cost_base));
    end if;
    v_sum_net := v_sum_net + v_net; v_sum_tax := v_sum_tax + v_tax;
  end loop;
  v_total := v_sum_net + v_sum_tax;
  if v_total <= 0 then raise exception 'NOTHING_TO_RETURN' using errcode = 'P0001'; end if;
  if p_settlement = 'reduce_due' and v_total > v_due_before + 0.005 then raise exception 'MORE_THAN_DUE' using errcode = 'P0001'; end if;
  if p_settlement <> 'reduce_due' and v_total > v_paid_before + 0.005 then raise exception 'MORE_THAN_PAID' using errcode = 'P0001'; end if;
  update sale_returns set net_amount = v_sum_net, tax_amount = v_sum_tax, total = v_total where id = v_ret;

  v_entries := jsonb_build_array(jsonb_build_object('account', 'AR_PATIENTS', 'credit', v_total, 'patient_id', v_inv.patient_id, 'store_id', v_inv.store_id, 'memo', v_no));
  if v_sum_net > 0 then v_entries := v_entries || jsonb_build_object('account', 'REV_PHARMACY', 'debit', v_sum_net, 'store_id', v_inv.store_id, 'memo', v_no); end if;
  if v_sum_tax > 0 then v_entries := v_entries || jsonb_build_object('account', 'TAX_PAYABLE', 'debit', v_sum_tax, 'memo', v_no); end if;
  for k in select jsonb_object_keys(v_restock_cost) loop
    if round((v_restock_cost->>k)::numeric, 2) > 0 then
      v_entries := v_entries || jsonb_build_object('account', 'INVENTORY', 'debit', round((v_restock_cost->>k)::numeric, 2), 'store_id', k::uuid, 'memo', v_no)
                             || jsonb_build_object('account', 'COGS', 'credit', round((v_restock_cost->>k)::numeric, 2), 'store_id', k::uuid, 'memo', v_no);
    end if;
  end loop;
  perform post_journal(p_tenant, v_post, v_entries);

  if p_settlement <> 'reduce_due' then
    v_pay := gen_random_uuid();
    select b.posting_id into v_post from begin_posting(p_tenant, md5(p_idempotency_key::text || ':refund')::uuid, 'payment', v_pay, p_by, p_session_level, p_device) b;
    select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'receipt', v_bp.id) d;
    v_rcpt := 'R-' || lpad(v_n::text, v_bp.invoice_pad, '0');
    insert into payments (id, tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, amount, cash_amount, online_amount, advance_amount, online_channel, reference, received_by, posting_id)
    values (v_pay, p_tenant, v_bp.id, v_rcpt, v_fy, v_inv.patient_id, -v_total,
            case when p_settlement = 'refund_cash' then -v_total else 0 end, case when p_settlement = 'refund_online' then -v_total else 0 end,
            case when p_settlement = 'to_advance' then -v_total else 0 end,
            case when p_settlement = 'refund_online' then p_channel end, 'refund ' || v_no, p_by, v_post);
    insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values (p_tenant, v_pay, v_inv.id, -v_total);
    update sale_returns set payment_id = v_pay where id = v_ret;
    perform post_journal(p_tenant, v_post, jsonb_build_array(
      jsonb_build_object('account', 'AR_PATIENTS', 'debit', v_total, 'patient_id', v_inv.patient_id, 'memo', v_rcpt),
      case when p_settlement = 'to_advance'
           then jsonb_build_object('account', 'PATIENT_ADVANCES', 'credit', v_total, 'patient_id', v_inv.patient_id, 'memo', v_rcpt)
           else jsonb_build_object('account', case when p_settlement = 'refund_cash' then 'CASH' else 'BANK' end, 'credit', v_total,
                         'channel', case when p_settlement = 'refund_cash' then 'cash' else p_channel end, 'store_id', v_inv.store_id) end));
  end if;

  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'invoice.return', 'invoice', v_inv.id::text, 'success',
          jsonb_build_object('return', v_no, 'total', v_total, 'settlement', p_settlement, 'lines', n));
  return jsonb_build_object('return_id', v_ret, 'return_no', v_no, 'total', v_total, 'refund_receipt', v_rcpt, 'replayed', false);
end $$;


revoke all on function rx_item_dispensed_base(uuid), rx_item_done(uuid, numeric) from public, anon, authenticated;
grant execute on function rx_item_dispensed_base(uuid), rx_item_done(uuid, numeric) to service_role;
