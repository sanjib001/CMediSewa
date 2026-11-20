-- =============================================================================
-- 0044 PHARMACY COUNTER (B7a): sale bills with item lines, each line taking stock from one
-- or more lots (FEFO or a chosen lot), at each lot's own price, with exact cost (COGS);
-- service lines; prescription-only items need an internal (issued) or external prescription;
-- controlled/narcotic items are blocked (P-22); the pharmacist's dispensing queue (C7).
-- database.md §11; workflows W-14; decisions D-35, D-42, D-49.
-- =============================================================================

create table external_prescriptions (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete restrict,
  patient_id          uuid,
  prescriber_name     text not null check (length(btrim(prescriber_name)) between 2 and 120),
  prescriber_reg_no   text check (length(prescriber_reg_no) <= 40),
  facility            text check (length(facility) <= 120),
  rx_date             date not null,
  recorded_by         uuid not null,
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, recorded_by) references tenant_members (tenant_id, id)
);

alter table invoices
  add column store_id uuid,
  add column customer_phone text check (customer_phone ~ '^[0-9+() -]{7,20}$'),
  add column external_prescription_id uuid;
alter table invoices
  add constraint invoices_store_fk foreign key (tenant_id, store_id) references stores (tenant_id, id),
  add constraint invoices_external_rx_fk foreign key (tenant_id, external_prescription_id) references external_prescriptions (tenant_id, id);

alter table invoice_lines
  add column item_id uuid,
  add column unit_id uuid,
  add column factor_snapshot numeric(14,4) check (factor_snapshot > 0),
  add column base_qty numeric(14,3) generated always as (round(qty * factor_snapshot, 3)) stored,
  add column cost_total numeric(14,2) not null default 0,
  add column prescription_item_id uuid,
  add column substitution_reason text check (length(substitution_reason) <= 200);
alter table invoice_lines
  add constraint invoice_lines_unit_fk foreign key (tenant_id, item_id, unit_id) references item_units (tenant_id, item_id, id),
  add constraint invoice_lines_rx_item_fk foreign key (tenant_id, prescription_item_id) references prescription_items (tenant_id, id),
  add constraint invoice_lines_item_complete check (line_type <> 'item' or (item_id is not null and unit_id is not null and factor_snapshot is not null));

-- One line per item, one allocation per lot it took from (D-42).
create table invoice_line_allocations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  invoice_line_id  uuid not null,
  item_id          uuid not null,
  batch_id         uuid not null,
  store_id         uuid not null,
  base_qty         numeric(14,3) not null check (base_qty > 0),
  unit_price_base  numeric(14,4) not null check (unit_price_base >= 0),
  unit_cost_base   numeric(14,4) not null check (unit_cost_base >= 0),
  unique (tenant_id, id),
  foreign key (tenant_id, invoice_line_id) references invoice_lines (tenant_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id)
);
create index invoice_line_allocations_line on invoice_line_allocations (invoice_line_id);

alter table external_prescriptions   enable row level security;
alter table invoice_line_allocations enable row level security;
revoke insert, update, delete on external_prescriptions, invoice_line_allocations from service_role;

-- =============================================================================
-- Sell at the counter (W-14). ONE transaction: stock out of the lots (FEFO unless a lot is
-- chosen with override_batch), the bill, its payment, both journal postings.
-- p_lines: [{ kind:'item', item_id, unit_id, qty, discount_pct, batch_id?, prescription_item_id?, substitution_reason? }
--           | { kind:'service', service_id, qty, discount_pct }]
-- p_external_rx: { prescriber_name, prescriber_reg_no, facility, rx_date } (for prescription-only
--                items sold without an internal prescription)
-- Journal: Dr AR_PATIENTS / Cr REV_PHARMACY, REV_SERVICES, TAX_PAYABLE; Dr COGS / Cr INVENTORY;
--          payment: Dr CASH / BANK / Cr AR_PATIENTS.
-- =============================================================================
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
  v_ext uuid; v_needs_ext boolean := false; v_entries jsonb; v_pay uuid; v_rcpt text; v_lot item_batches; v_today date; v_pct numeric;
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
  if v_due > 0 then
    if p_patient is null then raise exception 'PATIENT_REQUIRED_FOR_DUE' using errcode = 'P0001'; end if;
    if not v_set.allow_credit or not has_key(p_by, 'allow_credit') then raise exception 'PAYMENT_REQUIRED' using errcode = 'P0001'; end if;
    if v_due + coalesce((select sum(i.total) - coalesce(sum((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id)), 0)
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

  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'invoice.issue', 'invoice', v_inv::text, 'success',
          jsonb_build_object('no', v_no, 'store', p_store, 'total', v_total, 'paid', v_paid, 'lines', n, 'external_rx', v_ext is not null));
  return jsonb_build_object('invoice_id', v_inv, 'invoice_no', v_no, 'receipt_no', v_rcpt, 'total', v_total, 'paid', v_paid, 'due', v_due, 'replayed', false);
end $$;

-- The pharmacist's dispensing queue (C7, permissions.md §6): issued prescriptions of the last
-- 14 days with something not yet dispensed, showing ONLY the prescription items and the
-- patient's allergies. Needs dispense_prescription (a verified pharmacist). Audited.
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
                  'dispensed', exists (select 1 from invoice_lines il join invoices iv on iv.id = il.invoice_id where il.prescription_item_id = i.id and iv.status = 'issued'))
                  order by i.line_no) from prescription_items i where i.prescription_id = rx.id)) q
      from prescriptions rx
     where rx.tenant_id = p_tenant and rx.status = 'issued' and rx.issued_at > now() - interval '14 days'
       and exists (select 1 from prescription_items i where i.prescription_id = rx.id
                    and not exists (select 1 from invoice_lines il join invoices iv on iv.id = il.invoice_id where il.prescription_item_id = i.id and iv.status = 'issued'))
  ) s(q);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, outcome, detail)
  values (p_tenant, 'member', p_member, p_session_level, 'pharmacy.queue_read', 'success', jsonb_build_object('prescriptions', jsonb_array_length(v_out)));
  return jsonb_build_object('queue', v_out);
end $$;

-- ── ownership and privileges ──────────────────────────────────────────────────
grant select on medicine_details, prescriptions, prescription_items, external_prescriptions, invoice_line_allocations to ledger_writer;
grant insert on external_prescriptions, invoice_line_allocations to ledger_writer;
grant update on invoices, invoice_lines to ledger_writer;
grant execute on function stock_today(uuid), has_key(uuid, text) to ledger_writer;
grant create on schema public to ledger_writer;
alter function issue_counter_sale(uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, numeric, numeric, text, text, uuid, text, uuid) owner to ledger_writer;
revoke create on schema public from ledger_writer;
revoke all on function issue_counter_sale(uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, numeric, numeric, text, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function issue_counter_sale(uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, numeric, numeric, text, text, uuid, text, uuid) to service_role;
revoke all on function dispensing_queue(uuid, uuid, text) from public, anon, authenticated;
grant execute on function dispensing_queue(uuid, uuid, text) to service_role;
