-- =============================================================================
-- 0068 OTHER SALES (owner, D-158).
--  Where the pharmacy is also the billing counter, staff with the new "other_sales" permission
--  bill typed-in items (lab tests, dressings, ...) with a quantity and a price, under a bill
--  title such as "Lab". Such a line has no stock and no catalogue entry, carries no VAT, and
--  posts to REV_OTHER ("Other income"), which the finance report and P&L already show.
--  invoices.title: an optional heading printed on the bill.
--  invoice_lines.line_type gains 'other' (description required).
--  issue_counter_sale: body from the live database (0066), with p_title and 'other' lines.
--  Corrections: an 'other' line is not returnable line by line (no stock); void the bill.
-- =============================================================================

insert into permission_catalog (key, section, module_key, requires_profession, store_scoped)
values ('other_sales', 'pharmacy', 'pharmacy_counter', null, true)
on conflict (key) do nothing;

alter table invoices add column if not exists title text check (length(title) <= 60);

alter table invoice_lines drop constraint invoice_lines_line_type_check;
alter table invoice_lines add constraint invoice_lines_line_type_check check (line_type = any (array['service', 'item', 'other']));
alter table invoice_lines add constraint invoice_lines_other_described check (line_type <> 'other' or length(btrim(description)) > 0);

drop function issue_counter_sale(uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, numeric, numeric, text, text, uuid, text, uuid);

create function public.issue_counter_sale(p_tenant uuid, p_idempotency_key uuid, p_store uuid, p_patient uuid, p_customer_name text, p_customer_phone text, p_lines jsonb, p_external_rx jsonb, p_cash numeric, p_online numeric, p_channel text, p_reference text, p_by uuid, p_session_level text, p_device uuid, p_title text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_set tenant_settings; v_store stores; v_bp billing_profiles; v_inv uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_n bigint;
  v_no text; l jsonb; n integer := 0; v_item inventory_items; v_unit item_units; v_md medicine_details; v_svc services; v_qb numeric; v_line uuid;
  v_gross numeric; v_disc numeric; v_net numeric; v_tax numeric; v_cost numeric; a record; v_rxi prescription_items; v_rx prescriptions;
  v_sub numeric := 0; v_dsum numeric := 0; v_taxable numeric := 0; v_taxsum numeric := 0; v_rev_items numeric := 0; v_rev_svc numeric := 0; v_rev_other numeric := 0; v_price numeric; v_cogs numeric := 0;
  v_total numeric; v_cash numeric := round(coalesce(p_cash, 0), 2); v_online numeric := round(coalesce(p_online, 0), 2); v_paid numeric; v_due numeric;
  v_ext uuid; v_needs_ext boolean := false; v_entries jsonb; v_pay uuid; v_rcpt text; v_lot item_batches; v_today date; v_pct numeric; v_adv numeric := 0;
  v_hl stock_hold_lines; v_holds uuid[]; hr record;
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
  if length(btrim(coalesce(p_title, ''))) > 60 then raise exception 'BAD_TITLE' using errcode = 'P0001'; end if;
  if v_cash < 0 or v_online < 0 then raise exception 'BAD_PAYMENT' using errcode = 'P0001'; end if;
  if v_online > 0 and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_set from tenant_settings where tenant_id = p_tenant;
  v_today := stock_today(p_tenant);
  perform release_expired_holds(p_tenant, p_store);   -- M-45: holds whose time ran out free their stock first

  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'invoice', v_inv, p_by, p_session_level, p_device) b;
  if v_replayed then
    return (select jsonb_build_object('invoice_id', i.id, 'invoice_no', i.invoice_no, 'total', i.total, 'replayed', true) from invoices i where i.posting_id = v_post);
  end if;
  select * into v_bp from billing_profiles where tenant_id = p_tenant and is_active
   order by (id = v_store.billing_profile_id) desc, (id = v_set.default_billing_profile_id) desc, is_default desc limit 1;
  if v_bp.id is null then raise exception 'NO_BILLING_PROFILE' using errcode = 'P0001'; end if;
  select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'invoice', v_bp.id) d;
  v_no := case when v_bp.invoice_prefix = '' then '' else v_bp.invoice_prefix || '-' end || lpad(v_n::text, v_bp.invoice_pad, '0');
  insert into invoices (id, tenant_id, billing_profile_id, invoice_no, fiscal_year, patient_id, customer_name, customer_phone, source, store_id, title,
                        subtotal, discount_total, taxable_amount, tax_total, total, issued_by, posting_id)
  values (v_inv, p_tenant, v_bp.id, v_no, v_fy, p_patient, nullif(btrim(p_customer_name), ''), nullif(btrim(p_customer_phone), ''), 'counter', p_store, nullif(btrim(p_title), ''),
          0, 0, 0, 0, 0, p_by, v_post);

  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    v_line := gen_random_uuid();
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'BAD_QTY: line %', n using errcode = 'P0001'; end if;
    if coalesce((l->>'discount_pct')::numeric, 0) not between 0 and 100 then raise exception 'BAD_DISCOUNT: line %', n using errcode = 'P0001'; end if;

    if l->>'kind' = 'other' then
      -- 0068 Other sales: a typed-in line (lab test, dressing, ...), no stock, no catalogue, no VAT.
      if not has_key(p_by, 'other_sales') then raise exception 'NO_PERMISSION_OTHER_SALES' using errcode = 'P0001'; end if;
      if length(btrim(coalesce(l->>'description', ''))) not between 1 and 120 then raise exception 'BAD_DESCRIPTION: line %', n using errcode = 'P0001'; end if;
      v_price := round(coalesce((l->>'unit_price')::numeric, -1), 2);
      if v_price < 0 or v_price > 1000000 then raise exception 'BAD_PRICE: line %', n using errcode = 'P0001'; end if;
      v_gross := round((l->>'qty')::numeric * v_price, 2);
      v_disc := round(v_gross * coalesce((l->>'discount_pct')::numeric, 0) / 100, 2);
      v_net := v_gross - v_disc;
      v_tax := 0;
      insert into invoice_lines (id, tenant_id, invoice_id, line_no, line_type, description, qty, unit_price, discount_amount, tax_rate, tax_amount, line_total)
      values (v_line, p_tenant, v_inv, n, 'other', btrim(l->>'description'), (l->>'qty')::numeric, v_price, v_disc, 0, 0, v_net);
      v_rev_other := v_rev_other + v_net;
    elsif l->>'kind' = 'service' then
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
        -- D-147: another brand than the one prescribed must be the same medicine (generic,
        -- strength, form; never a combination product), and the reason is recorded.
        if v_rxi.item_id is not null and v_rxi.item_id <> v_item.id then
          if not medicine_equivalent(p_tenant, v_rxi.item_id, v_item.id) then raise exception 'NOT_EQUIVALENT: line %', n using errcode = 'P0001'; end if;
          if length(btrim(coalesce(l->>'substitution_reason', ''))) < 3 then raise exception 'SUBSTITUTION_REASON_REQUIRED: line %', n using errcode = 'P0001'; end if;
        end if;
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
      if nullif(l->>'hold_line_id', '') is not null then
        -- M-45: collecting a hold. The line sells from the held lot, up to what was held; the
        -- reservation drops first so the held stock is free for this sale only.
        select hl.* into v_hl from stock_hold_lines hl join stock_holds h on h.id = hl.hold_id
         where hl.id = (l->>'hold_line_id')::uuid and hl.tenant_id = p_tenant and h.status = 'held' and h.store_id = p_store
           and hl.item_id = v_item.id and hl.collected_base = 0
           and (h.patient_id is null or h.patient_id = p_patient or exists (select 1 from patients x where x.id = h.patient_id and x.merged_into = p_patient))
           for update of h, hl;
        if v_hl.id is null then raise exception 'HOLD_NOT_VALID: line %', n using errcode = 'P0001'; end if;
        if v_qb > v_hl.qty_base then raise exception 'MORE_THAN_HELD: line %', n using errcode = 'P0001'; end if;
        select * into v_lot from item_batches where id = v_hl.batch_id;
        if v_lot.status <> 'active' or (v_lot.expiry_date is not null and v_lot.expiry_date <= v_today) then raise exception 'LOT_NOT_SELLABLE: line %', n using errcode = 'P0001'; end if;
        update stock_hold_lines set collected_base = v_qb where id = v_hl.id;
        perform sync_reserved(p_tenant, p_store, v_lot.id);
        if not (v_hl.hold_id = any(coalesce(v_holds, '{}'))) then v_holds := array_append(v_holds, v_hl.hold_id); end if;
        perform 1 from stock_balances where tenant_id = p_tenant and store_id = p_store and batch_id = v_lot.id for update;
        insert into invoice_line_allocations (tenant_id, invoice_line_id, item_id, batch_id, store_id, base_qty, unit_price_base, unit_cost_base)
        values (p_tenant, v_line, v_item.id, v_lot.id, p_store, v_qb, v_lot.sale_price_base, v_lot.unit_cost_base);
        perform write_movement(p_tenant, p_store, v_lot.id, v_item.id, -v_qb, 'sale', v_lot.unit_cost_base, v_post, 'invoice', v_inv, v_line, null, p_by);
        v_gross := v_qb * v_lot.sale_price_base; v_cost := v_qb * v_lot.unit_cost_base;
      elsif nullif(l->>'batch_id', '') is not null then
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

  -- M-45: each hold collected here ends; whatever it held that this bill didn't take goes back.
  if v_holds is not null then
    update stock_holds set status = 'collected', invoice_id = v_inv, ended_at = now(), ended_by = p_by,
           end_reason = case when exists (select 1 from stock_hold_lines x where x.hold_id = stock_holds.id and x.collected_base < x.qty_base)
                             then 'Collected in part; the rest went back to the shelf' end
     where id = any(v_holds);
    for hr in select distinct store_id, batch_id from stock_hold_lines where hold_id = any(v_holds) loop
      perform sync_reserved(p_tenant, hr.store_id, hr.batch_id);
    end loop;
  end if;

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
  if v_rev_other > 0 then v_entries := v_entries || jsonb_build_object('account', 'REV_OTHER', 'credit', v_rev_other, 'store_id', p_store, 'memo', v_no); end if;
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
          jsonb_build_object('no', v_no, 'store', p_store, 'total', v_total, 'paid', v_paid, 'from_advance', v_adv, 'lines', n, 'external_rx', v_ext is not null, 'holds', to_jsonb(v_holds), 'title', nullif(btrim(p_title), '')));
  return jsonb_build_object('invoice_id', v_inv, 'invoice_no', v_no, 'receipt_no', v_rcpt, 'total', v_total, 'paid', v_paid, 'due', v_due - v_adv, 'from_advance', v_adv, 'replayed', false);
end $function$;

grant create on schema public to ledger_writer;
alter function issue_counter_sale(uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, numeric, numeric, text, text, uuid, text, uuid, text) owner to ledger_writer;
revoke create on schema public from ledger_writer;
revoke all on function issue_counter_sale(uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, numeric, numeric, text, text, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function issue_counter_sale(uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, numeric, numeric, text, text, uuid, text, uuid, text) to service_role;
