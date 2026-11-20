-- 0023 Fixes found by tests/db/front-desk.test.mjs before any use:
-- 1. Duplicate flag: a generated column (phone_digits) is not yet computed in a BEFORE
--    INSERT trigger, so the phone match never fired. Compute the digits in the trigger.
-- 2. check_in_visit: an online leg with NO channel passed the channel check (NULL NOT IN …
--    is NULL) and was only stopped by a table constraint. Now CHANNEL_REQUIRED.
-- 3. check_in_visit: another clinic's service was stopped by a foreign key rather than a
--    clear SERVICE_NOT_FOUND. Validated before anything is written.
-- check_in_visit keeps its owner (ledger_writer) on replace.

create or replace function patients_stamp()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_no bigint; v_first text := lower(split_part(btrim(new.full_name), ' ', 1));
        v_digits text := nullif(regexp_replace(coalesce(new.phone, ''), '\D', '', 'g'), '');
begin
  insert into patient_mrn_counters as c (tenant_id, next_no) values (new.tenant_id, 2)
  on conflict (tenant_id) do update set next_no = c.next_no + 1
  returning next_no - 1 into v_no;
  new.mrn := lpad(v_no::text, 6, '0');
  -- Same phone and same first name, or same full name and date of birth: probably the
  -- same person registered twice. Flag only; staff decide.
  new.possible_duplicate := exists (
    select 1 from patients p where p.tenant_id = new.tenant_id and p.deleted_at is null and (
      (v_digits is not null and p.phone_digits = v_digits and lower(split_part(btrim(p.full_name), ' ', 1)) = v_first)
      or (new.date_of_birth is not null and p.date_of_birth = new.date_of_birth and lower(btrim(p.full_name)) = lower(btrim(new.full_name)))));
  return new;
end $$;

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
