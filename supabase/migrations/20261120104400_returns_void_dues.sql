-- =============================================================================
-- 0045 SALES RETURNS, VOID, DUES (B7b): customer returns against the original bill, per lot
-- sold (back to the shelf, to quarantine, or destroyed), settled by refund or by reducing the
-- due; same-day void of a whole bill; collecting dues oldest bill first.
-- database.md §11.6; workflows W-13 §7, W-25; decisions D-105..D-107.
-- =============================================================================

create table sale_returns (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete restrict,
  billing_profile_id  uuid not null,
  return_no           text not null,
  fiscal_year         text not null,
  invoice_id          uuid not null,
  patient_id          uuid,
  settlement          text not null check (settlement in ('refund_cash', 'refund_online', 'reduce_due')),
  online_channel      text check (online_channel in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')),
  net_amount          numeric(12,2) not null check (net_amount >= 0),
  tax_amount          numeric(12,2) not null default 0 check (tax_amount >= 0),
  total               numeric(12,2) not null check (total > 0),
  reason              text not null check (length(btrim(reason)) between 3 and 300),
  payment_id          uuid,
  posting_id          uuid not null,
  created_by          uuid not null,
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, billing_profile_id, fiscal_year, return_no),
  foreign key (tenant_id, billing_profile_id) references billing_profiles (tenant_id, id),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, payment_id) references payments (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  foreign key (tenant_id, created_by) references tenant_members (tenant_id, id),
  check (total = net_amount + tax_amount),
  check ((settlement = 'refund_online') = (online_channel is not null))
);
create index sale_returns_invoice on sale_returns (invoice_id);

create table sale_return_lines (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  return_id       uuid not null,
  allocation_id   uuid not null,
  item_id         uuid not null,
  batch_id        uuid not null,
  qty_base        numeric(14,3) not null check (qty_base > 0),
  restock         text not null check (restock in ('sellable', 'quarantine', 'none')),
  to_store_id     uuid,
  net_amount      numeric(12,2) not null check (net_amount >= 0),
  tax_amount      numeric(12,2) not null default 0 check (tax_amount >= 0),
  cost            numeric(12,2) not null check (cost >= 0),
  unique (tenant_id, id),
  foreign key (tenant_id, return_id) references sale_returns (tenant_id, id),
  foreign key (tenant_id, allocation_id) references invoice_line_allocations (tenant_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id),
  foreign key (tenant_id, to_store_id) references stores (tenant_id, id),
  check ((restock = 'none') = (to_store_id is null))
);
create index sale_return_lines_allocation on sale_return_lines (allocation_id);

alter table sale_returns      enable row level security;
alter table sale_return_lines enable row level security;
revoke insert, update, delete on sale_returns, sale_return_lines from service_role;

-- What a bill still owes: total − returned − net paid (refunds are negative payments). Void = 0.
create or replace function invoice_outstanding(p_invoice uuid)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  select case when i.status <> 'issued' then 0 else
         i.total - coalesce((select sum(r.total) from sale_returns r where r.invoice_id = i.id), 0)
                 - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0) end
    from invoices i where i.id = p_invoice;
$$;

-- Net received against a bill (payments minus refunds).
create or replace function invoice_paid(p_invoice uuid)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$ select coalesce(sum(amount), 0) from payment_allocations where invoice_id = p_invoice; $$;

-- The clinic's business day (day_closing_hour) of a moment.
create or replace function business_day(p_tenant uuid, p_at timestamptz)
returns date
language sql stable
set search_path = pg_catalog, public
as $$
  select ((p_at at time zone t.timezone) - make_interval(hours => s.day_closing_hour))::date
    from tenants t join tenant_settings s on s.tenant_id = t.id where t.id = p_tenant;
$$;

-- Patients' open bills, oldest first (for the Dues screen and collection).
create or replace function patient_open_bills(p_tenant uuid, p_patient uuid default null)
returns table (invoice_id uuid, patient_id uuid, invoice_no text, billing_profile_id uuid, issued_at timestamptz, total numeric, outstanding numeric)
language sql stable
set search_path = pg_catalog, public
as $$
  select i.id, i.patient_id, i.invoice_no, i.billing_profile_id, i.issued_at, i.total, invoice_outstanding(i.id)
    from invoices i
   where i.tenant_id = p_tenant and i.status = 'issued' and i.patient_id is not null
     and (p_patient is null or i.patient_id = p_patient) and invoice_outstanding(i.id) > 0
   order by i.issued_at, i.invoice_no;
$$;

-- =============================================================================
-- Customer return (W-25). p_lines: [{ allocation_id, qty_base, restock: sellable|quarantine|none }]
-- Value per allocation = qty × the lot's own sale price, less the line's discount share, plus its VAT.
-- Journal: Dr REV_PHARMACY (net) + TAX_PAYABLE (VAT) / Cr AR_PATIENTS; restocked: Dr INVENTORY /
-- Cr COGS at the lot's cost; refund: Dr AR_PATIENTS / Cr CASH|BANK (a negative receipt).
-- =============================================================================
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
  if p_settlement not in ('refund_cash', 'refund_online', 'reduce_due') then raise exception 'BAD_SETTLEMENT' using errcode = 'P0001'; end if;
  if p_settlement = 'refund_online' and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select * into v_inv from invoices where id = p_invoice and tenant_id = p_tenant for update;
  if v_inv.id is null then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_inv.status <> 'issued' then raise exception 'INVOICE_VOID' using errcode = 'P0001'; end if;

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
    insert into payments (id, tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, amount, cash_amount, online_amount, online_channel, reference, received_by, posting_id)
    values (v_pay, p_tenant, v_bp.id, v_rcpt, v_fy, v_inv.patient_id, -v_total,
            case when p_settlement = 'refund_cash' then -v_total else 0 end, case when p_settlement = 'refund_online' then -v_total else 0 end,
            case when p_settlement = 'refund_online' then p_channel end, 'refund ' || v_no, p_by, v_post);
    insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values (p_tenant, v_pay, v_inv.id, -v_total);
    update sale_returns set payment_id = v_pay where id = v_ret;
    perform post_journal(p_tenant, v_post, jsonb_build_array(
      jsonb_build_object('account', 'AR_PATIENTS', 'debit', v_total, 'patient_id', v_inv.patient_id, 'memo', v_rcpt),
      jsonb_build_object('account', case when p_settlement = 'refund_cash' then 'CASH' else 'BANK' end, 'credit', v_total,
                         'channel', case when p_settlement = 'refund_cash' then 'cash' else p_channel end, 'store_id', v_inv.store_id)));
  end if;

  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'invoice.return', 'invoice', v_inv.id::text, 'success',
          jsonb_build_object('return', v_no, 'total', v_total, 'settlement', p_settlement, 'lines', n));
  return jsonb_build_object('return_id', v_ret, 'return_no', v_no, 'total', v_total, 'refund_receipt', v_rcpt, 'replayed', false);
end $$;

-- =============================================================================
-- Void a whole bill (W-13 §7): same business day, nothing returned against it, A2 + re-auth.
-- Stock goes back to the original lots and stores, the sale's journal is reversed, and what was
-- received is refunded in the same legs (cash/online) as it came in.
-- =============================================================================
create or replace function void_invoice(
  p_tenant uuid, p_idempotency_key uuid, p_invoice uuid, p_reason text,
  p_by uuid, p_session_level text, p_reauth_at timestamptz, p_device uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_inv invoices; v_rev uuid; v_post uuid; v_replayed boolean; a invoice_line_allocations; p record; v_bp billing_profiles; v_fy text; v_n bigint; v_rcpt text;
  v_pay uuid; v_cash numeric; v_online numeric; v_refunded numeric := 0; v_entries jsonb;
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
  for p in select pm.id, pm.amount, pm.cash_amount, pm.online_amount, pm.online_channel, sum(pa.amount) share
             from payment_allocations pa join payments pm on pm.id = pa.payment_id
            where pa.invoice_id = v_inv.id group by pm.id having sum(pa.amount) > 0 loop
    v_cash := round(p.share * p.cash_amount / p.amount, 2); v_online := p.share - v_cash;
    v_pay := gen_random_uuid();
    select b.posting_id into v_post from begin_posting(p_tenant, md5(p_idempotency_key::text || ':' || p.id::text)::uuid, 'payment', v_pay, p_by, p_session_level, p_device) b;
    select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'receipt', v_bp.id) d;
    v_rcpt := 'R-' || lpad(v_n::text, v_bp.invoice_pad, '0');
    insert into payments (id, tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, amount, cash_amount, online_amount, online_channel, reference, received_by, posting_id)
    values (v_pay, p_tenant, v_bp.id, v_rcpt, v_fy, v_inv.patient_id, -p.share, -v_cash, -v_online, case when v_online <> 0 then p.online_channel end,
            'void ' || v_inv.invoice_no, p_by, v_post);
    insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values (p_tenant, v_pay, v_inv.id, -p.share);
    v_entries := jsonb_build_array(jsonb_build_object('account', 'AR_PATIENTS', 'debit', p.share, 'patient_id', v_inv.patient_id, 'memo', v_rcpt));
    if v_cash <> 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'credit', v_cash, 'channel', 'cash', 'store_id', v_inv.store_id); end if;
    if v_online <> 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'credit', v_online, 'channel', p.online_channel, 'store_id', v_inv.store_id); end if;
    perform post_journal(p_tenant, v_post, v_entries);
    v_refunded := v_refunded + p.share;
  end loop;

  update invoices set status = 'void', void_reason = btrim(p_reason), voided_by = p_by, voided_at = now() where id = v_inv.id;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'invoice.void', 'invoice', v_inv.id::text, 'success', btrim(p_reason),
          jsonb_build_object('no', v_inv.invoice_no, 'total', v_inv.total, 'refunded', v_refunded));
  return jsonb_build_object('invoice_id', v_inv.id, 'refunded', v_refunded, 'replayed', false);
end $$;

-- =============================================================================
-- Collect a patient's dues (database.md §11.5): oldest bill first, within one billing profile
-- (the oldest bill's). Journal: Dr CASH / BANK / Cr AR_PATIENTS.
-- =============================================================================
create or replace function collect_patient_dues(
  p_tenant uuid, p_idempotency_key uuid, p_patient uuid, p_cash numeric, p_online numeric, p_channel text, p_reference text,
  p_by uuid, p_session_level text, p_device uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_pay uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_cash numeric := round(coalesce(p_cash, 0), 2); v_online numeric := round(coalesce(p_online, 0), 2);
  v_amt numeric; v_left numeric; v_bp billing_profiles; v_fy text; v_n bigint; v_rcpt text; b record; v_take numeric; v_entries jsonb; v_bills integer := 0;
begin
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not (has_key(p_by, 'manage_billing') or has_key(p_by, 'pharmacy_sell')) then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if v_cash < 0 or v_online < 0 or v_cash + v_online <= 0 then raise exception 'BAD_AMOUNT' using errcode = 'P0001'; end if;
  if v_online > 0 and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  if not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant) then raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('dues:' || p_patient::text, 0));   -- one collection at a time per patient
  select b2.posting_id, b2.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'payment', v_pay, p_by, p_session_level, p_device) b2;
  if v_replayed then
    return (select jsonb_build_object('payment_id', pm.id, 'receipt_no', pm.receipt_no, 'amount', pm.amount, 'replayed', true) from payments pm where pm.posting_id = v_post);
  end if;
  select bp.* into v_bp from patient_open_bills(p_tenant, p_patient) o join billing_profiles bp on bp.id = o.billing_profile_id order by o.issued_at limit 1;
  if v_bp.id is null then raise exception 'NO_DUES' using errcode = 'P0001'; end if;
  v_amt := v_cash + v_online;
  if v_amt > (select sum(outstanding) from patient_open_bills(p_tenant, p_patient) where billing_profile_id = v_bp.id) + 0.005 then raise exception 'OVERPAYMENT' using errcode = 'P0001'; end if;
  select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'receipt', v_bp.id) d;
  v_rcpt := 'R-' || lpad(v_n::text, v_bp.invoice_pad, '0');
  insert into payments (id, tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, amount, cash_amount, online_amount, online_channel, reference, received_by, posting_id)
  values (v_pay, p_tenant, v_bp.id, v_rcpt, v_fy, p_patient, v_amt, v_cash, v_online, case when v_online > 0 then p_channel end, nullif(btrim(coalesce(p_reference, '')), ''), p_by, v_post);
  v_left := v_amt;
  for b in select * from patient_open_bills(p_tenant, p_patient) where billing_profile_id = v_bp.id loop
    exit when v_left <= 0;
    v_take := least(v_left, b.outstanding);
    insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values (p_tenant, v_pay, b.invoice_id, v_take);
    v_left := v_left - v_take; v_bills := v_bills + 1;
  end loop;
  v_entries := jsonb_build_array(jsonb_build_object('account', 'AR_PATIENTS', 'credit', v_amt, 'patient_id', p_patient, 'memo', v_rcpt));
  if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'debit', v_cash, 'channel', 'cash'); end if;
  if v_online > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'debit', v_online, 'channel', p_channel); end if;
  perform post_journal(p_tenant, v_post, v_entries);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'dues.collect', 'patient', p_patient::text, 'success', jsonb_build_object('receipt', v_rcpt, 'amount', v_amt, 'bills', v_bills));
  return jsonb_build_object('payment_id', v_pay, 'receipt_no', v_rcpt, 'amount', v_amt, 'bills', v_bills, 'replayed', false);
end $$;

-- ── ownership and privileges ──────────────────────────────────────────────────
grant select on sale_returns, sale_return_lines, payments, payment_allocations, invoices, invoice_lines, invoice_line_allocations, patients to ledger_writer;
grant insert on sale_returns, sale_return_lines to ledger_writer;
grant update on sale_returns to ledger_writer;
grant execute on function invoice_outstanding(uuid), invoice_paid(uuid), business_day(uuid, timestamptz), patient_open_bills(uuid, uuid) to ledger_writer;
grant create on schema public to ledger_writer;
alter function post_sale_return(uuid, uuid, uuid, text, text, text, jsonb, uuid, text, timestamptz, uuid) owner to ledger_writer;
alter function void_invoice(uuid, uuid, uuid, text, uuid, text, timestamptz, uuid) owner to ledger_writer;
alter function collect_patient_dues(uuid, uuid, uuid, numeric, numeric, text, text, uuid, text, uuid) owner to ledger_writer;
revoke create on schema public from ledger_writer;
revoke all on function post_sale_return(uuid, uuid, uuid, text, text, text, jsonb, uuid, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function void_invoice(uuid, uuid, uuid, text, uuid, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function collect_patient_dues(uuid, uuid, uuid, numeric, numeric, text, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function post_sale_return(uuid, uuid, uuid, text, text, text, jsonb, uuid, text, timestamptz, uuid) to service_role;
grant execute on function void_invoice(uuid, uuid, uuid, text, uuid, text, timestamptz, uuid) to service_role;
grant execute on function collect_patient_dues(uuid, uuid, uuid, numeric, numeric, text, text, uuid, text, uuid) to service_role;
revoke all on function invoice_outstanding(uuid), invoice_paid(uuid), business_day(uuid, timestamptz), patient_open_bills(uuid, uuid) from public, anon, authenticated;
grant execute on function invoice_outstanding(uuid), invoice_paid(uuid), business_day(uuid, timestamptz), patient_open_bills(uuid, uuid) to service_role;
