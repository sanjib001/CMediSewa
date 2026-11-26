-- =============================================================================
-- 0066 ONE BATCH, ONE LOT (owner, D-152).
--  Buying the same batch of the same medicine again (same vendor, same expiry, same cost per base
--  unit, MRP and sale price) adds to the lot already on file instead of making a second lot, so
--  Stock shows one line per batch. A different cost, MRP, expiry or vendor stays a separate lot,
--  so stock values and returns to the vendor stay exact.
--  post_purchase_invoice: each line's final lot cost (after its share of the bill discount and
--    free goods) is worked out before the lot is chosen; a reused lot keeps its first bill line.
--  void_purchase_invoice: allowed while what this bill brought is still free on the shelf.
--  post_purchase_return: against a bill, limited to what that bill brought into the lot.
-- =============================================================================

create or replace function post_purchase_invoice(p_tenant uuid, p_idempotency_key uuid, p_vendor uuid, p_vendor_invoice_no text, p_vendor_invoice_date date, p_store uuid, p_lines jsonb, p_bill_discount numeric, p_round_off numeric, p_paid_cash numeric, p_paid_online numeric, p_online_channel text, p_note text, p_by uuid, p_session_level text, p_device uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text; v_set tenant_settings; l jsonb; n integer := 0;
  v_unit item_units; v_item inventory_items; v_gross numeric; v_disc numeric; v_net numeric; v_tax numeric;
  v_sub numeric := 0; v_ldisc numeric := 0; v_taxable numeric := 0; v_taxsum numeric := 0; v_total numeric; v_bill numeric := round(coalesce(p_bill_discount, 0), 2);
  v_round numeric := round(coalesce(p_round_off, 0), 2); v_cash numeric := round(coalesce(p_paid_cash, 0), 2); v_online numeric := round(coalesce(p_paid_online, 0), 2);
  v_credit numeric; v_line uuid; v_batch uuid; v_qb numeric; v_fb numeric; v_cost_base numeric; v_inv_value numeric := 0; v_entries jsonb := '[]';
  r record; v_share numeric; v_today date; v_po_line uuid; v_pol purchase_order_lines; v_po uuid;
  v_pre numeric; v_bn text; v_mrp_b numeric; v_sp_b numeric; v_cost_new numeric; v_new_lot boolean;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_purchases') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_store), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  if not exists (select 1 from stores where id = p_store and tenant_id = p_tenant and is_active and is_receiving) then raise exception 'STORE_NOT_RECEIVING' using errcode = 'P0001'; end if;
  if not exists (select 1 from vendors where id = p_vendor and tenant_id = p_tenant and is_active) then raise exception 'VENDOR_NOT_FOUND' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_vendor_invoice_no), '') = '' then raise exception 'BILL_NO_REQUIRED' using errcode = 'P0001'; end if;
  v_today := stock_today(p_tenant);
  if p_vendor_invoice_date is null or p_vendor_invoice_date > v_today then raise exception 'BAD_BILL_DATE' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  if v_cash < 0 or v_online < 0 then raise exception 'BAD_PAYMENT' using errcode = 'P0001'; end if;
  if v_online > 0 and (p_online_channel is null or p_online_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then
    raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001';
  end if;
  select * into v_set from tenant_settings where tenant_id = p_tenant;

  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'purchase_invoice', v_id, p_by, p_session_level, p_device) b;
  if v_replayed then return (select id from purchase_invoices where posting_id = v_post); end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'purchase', 'PUR') d;
  -- header first (totals filled after the lines); placeholder total satisfies the CHECKs
  insert into purchase_invoices (id, tenant_id, purchase_no, fiscal_year, vendor_id, vendor_invoice_no, vendor_invoice_date, received_store_id,
                                 total, credit_amount, note, posted_by, posting_id)
  values (v_id, p_tenant, v_no, v_fy, p_vendor, btrim(p_vendor_invoice_no), p_vendor_invoice_date, p_store, 0, 0, nullif(btrim(p_note), ''), p_by, v_post);

  -- D-152: the bill's net before the bill discount, so each line's final lot cost is known before
  -- its lot is chosen (the same rounding as the lines below).
  select coalesce(sum(g - round(g * coalesce((x->>'discount_pct')::numeric, 0) / 100, 2)), 0) into v_pre
    from (select x, round(coalesce((x->>'qty')::numeric, 0) * coalesce((x->>'unit_cost')::numeric, 0), 2) g from jsonb_array_elements(p_lines) x) s;

  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    select * into v_item from inventory_items where id = (l->>'item_id')::uuid and tenant_id = p_tenant and deleted_at is null;
    if v_item.id is null then raise exception 'ITEM_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
    select * into v_unit from item_units where id = (l->>'unit_id')::uuid and item_id = v_item.id;
    if v_unit.id is null then raise exception 'UNIT_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'BAD_QTY: line %', n using errcode = 'P0001'; end if;
    if v_item.item_type = 'medicine' then
      if nullif(l->>'expiry_date', '') is null then raise exception 'EXPIRY_REQUIRED: line %', n using errcode = 'P0001'; end if;
      if (l->>'expiry_date')::date <= p_vendor_invoice_date then raise exception 'EXPIRED_ON_ARRIVAL: line %', n using errcode = 'P0001'; end if;
      if (l->>'expiry_date')::date < v_today + v_set.min_receive_shelf_days and coalesce(btrim(l->>'short_expiry_reason'), '') = '' then
        raise exception 'SHORT_SHELF_LIFE: line %', n using errcode = 'P0001';
      end if;
    end if;
    v_gross := round((l->>'qty')::numeric * coalesce((l->>'unit_cost')::numeric, 0), 2);
    v_disc := round(v_gross * coalesce((l->>'discount_pct')::numeric, 0) / 100, 2);
    v_net := v_gross - v_disc;
    v_tax := round(v_net * coalesce((l->>'tax_rate')::numeric, 0) / 100, 2);
    if nullif(l->>'mrp', '') is not null and coalesce(nullif(l->>'sale_price', '')::numeric, (l->>'mrp')::numeric) > (l->>'mrp')::numeric and not v_set.allow_price_above_mrp then
      raise exception 'PRICE_ABOVE_MRP: line %', n using errcode = 'P0001';
    end if;
    v_po_line := nullif(l->>'po_line_id', '')::uuid;
    if v_po_line is not null then
      select pol.* into v_pol from purchase_order_lines pol join purchase_orders po on po.id = pol.po_id
       where pol.id = v_po_line and po.tenant_id = p_tenant and po.vendor_id = p_vendor and po.status in ('open', 'partially_received') and pol.item_id = v_item.id;
      if v_pol.id is null then raise exception 'PO_LINE_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
      v_po := coalesce(v_po, v_pol.po_id);
    end if;
    v_line := gen_random_uuid();
    v_qb := round((l->>'qty')::numeric * v_unit.factor_to_base, 3);
    v_fb := round(coalesce((l->>'free_qty')::numeric, 0) * v_unit.factor_to_base, 3);
    -- D-152: one batch, one lot. A batch already on file for this medicine from this vendor, with
    -- the same expiry, the same cost per base unit (after the line discount, its share of the bill
    -- discount and free goods), MRP and sale price, takes this delivery too; otherwise a new lot.
    v_bn := upper(btrim(coalesce(nullif(l->>'batch_no', ''), case when v_item.item_type = 'medicine' then null else 'NA' end)));
    v_mrp_b := round(nullif(l->>'mrp', '')::numeric / v_unit.factor_to_base, 4);
    v_sp_b := round(coalesce(nullif(l->>'sale_price', '')::numeric, nullif(l->>'mrp', '')::numeric, coalesce((l->>'unit_cost')::numeric, 0)) / v_unit.factor_to_base, 4);
    v_cost_new := round((v_net - case when v_pre > 0 then round(v_bill * v_net / v_pre, 2) else 0 end) / nullif(v_qb + v_fb, 0), 4);
    v_batch := null;
    if v_bn is not null and v_bn <> 'NA' then
      select ib.id into v_batch from item_batches ib
       where ib.tenant_id = p_tenant and ib.item_id = v_item.id and ib.batch_no = v_bn and ib.source = 'purchase' and ib.status = 'active'
         and ib.vendor_id = p_vendor and ib.expiry_date is not distinct from nullif(l->>'expiry_date', '')::date
         and ib.unit_cost_base = v_cost_new and ib.mrp_base is not distinct from v_mrp_b and ib.sale_price_base = v_sp_b
       order by ib.created_at limit 1;
    end if;
    v_new_lot := v_batch is null;
    if v_new_lot then
      insert into item_batches (tenant_id, item_id, batch_no, mfg_date, expiry_date, source, vendor_id, unit_cost_base, mrp_base, sale_price_base)
      values (p_tenant, v_item.id, v_bn, nullif(l->>'mfg_date', '')::date, nullif(l->>'expiry_date', '')::date, 'purchase', p_vendor, coalesce(v_cost_new, 0), v_mrp_b, v_sp_b)
      returning id into v_batch;
    end if;
    insert into purchase_invoice_lines (id, tenant_id, purchase_id, line_no, item_id, unit_id, qty, free_qty, factor_snapshot, unit_cost, discount_pct, discount_amount,
                                        tax_rate, tax_amount, line_net, batch_no, mfg_date, expiry_date, mrp, sale_price, batch_id, po_line_id)
    values (v_line, p_tenant, v_id, n, v_item.id, v_unit.id, (l->>'qty')::numeric, coalesce((l->>'free_qty')::numeric, 0), v_unit.factor_to_base,
            coalesce((l->>'unit_cost')::numeric, 0), coalesce((l->>'discount_pct')::numeric, 0), v_disc, coalesce((l->>'tax_rate')::numeric, 0), v_tax, v_net,
            upper(btrim(coalesce(nullif(l->>'batch_no', ''), 'NA'))), nullif(l->>'mfg_date', '')::date, nullif(l->>'expiry_date', '')::date,
            nullif(l->>'mrp', '')::numeric, nullif(l->>'sale_price', '')::numeric, v_batch, v_po_line);
    if v_new_lot then update item_batches set purchase_invoice_line_id = v_line where id = v_batch; end if;
    v_sub := v_sub + v_gross; v_ldisc := v_ldisc + v_disc; v_taxable := v_taxable + v_net; v_taxsum := v_taxsum + v_tax;
  end loop;

  if v_bill > v_taxable then raise exception 'BAD_DISCOUNT' using errcode = 'P0001'; end if;
  -- Bill discount reduces tax pro rata as well (tax was on the pre-bill-discount net).
  if v_bill > 0 and v_taxable > 0 then v_taxsum := round(v_taxsum * (v_taxable - v_bill) / v_taxable, 2); end if;
  v_total := v_taxable - v_bill + v_taxsum + v_round;
  if v_cash + v_online > v_total then raise exception 'OVERPAYMENT' using errcode = 'P0001'; end if;
  v_credit := v_total - v_cash - v_online;

  -- Lot cost = (line net − its share of the bill discount) ÷ (paid + free base qty): free goods dilute cost.
  for r in select * from purchase_invoice_lines where purchase_id = v_id order by line_no loop
    v_share := case when v_taxable > 0 then round(v_bill * r.line_net / v_taxable, 2) else 0 end;
    v_cost_base := round((r.line_net - v_share) / (r.base_qty + r.free_base_qty), 4);
    update item_batches set unit_cost_base = v_cost_base where id = r.batch_id and unit_cost_base <> v_cost_base and purchase_invoice_line_id = r.id;
    perform write_movement(p_tenant, p_store, r.batch_id, r.item_id, r.base_qty + r.free_base_qty, 'purchase', v_cost_base, v_post, 'purchase_invoice', v_id, r.id, null, p_by);
    v_inv_value := v_inv_value + (r.line_net - v_share);
  end loop;

  for r in select distinct pol.po_id from purchase_invoice_lines l join purchase_order_lines pol on pol.id = l.po_line_id where l.purchase_id = v_id loop
    perform po_refresh_status(r.po_id);
  end loop;
  update purchase_invoices set po_id = v_po, subtotal = v_sub, line_discount_total = v_ldisc, bill_discount = v_bill, taxable_amount = v_taxable - v_bill,
         tax_amount = v_taxsum, round_off = v_round, total = v_total, paid_cash = v_cash, paid_online = v_online,
         online_channel = case when v_online > 0 then p_online_channel end, credit_amount = v_credit
   where id = v_id;

  v_entries := jsonb_build_array(jsonb_build_object('account', 'INVENTORY', 'debit', v_inv_value, 'store_id', p_store, 'vendor_id', p_vendor, 'memo', v_no));
  if v_taxsum > 0 then v_entries := v_entries || jsonb_build_object('account', 'TAX_RECEIVABLE', 'debit', v_taxsum, 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_round > 0 then v_entries := v_entries || jsonb_build_object('account', 'ROUNDING', 'debit', v_round, 'memo', v_no); end if;
  if v_round < 0 then v_entries := v_entries || jsonb_build_object('account', 'ROUNDING', 'credit', -v_round, 'memo', v_no); end if;
  if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'credit', v_cash, 'channel', 'cash', 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_online > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'credit', v_online, 'channel', p_online_channel, 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_credit > 0 then v_entries := v_entries || jsonb_build_object('account', 'AP_VENDORS', 'credit', v_credit, 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_total > 0 then perform post_journal(p_tenant, v_post, v_entries); end if;

  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'purchase.post', 'purchase_invoice', v_id::text, 'success',
          jsonb_build_object('no', v_no, 'vendor', p_vendor, 'bill', btrim(p_vendor_invoice_no), 'total', v_total, 'credit', v_credit));
  return v_id;
exception when unique_violation then
  if sqlerrm like '%purchase_invoices_no_duplicate%' then raise exception 'DUPLICATE_BILL' using errcode = 'P0001'; end if;
  raise;
end $function$;

create or replace function void_purchase_invoice(p_tenant uuid, p_idempotency_key uuid, p_invoice uuid, p_reason text, p_by uuid, p_session_level text, p_reauth_at timestamp with time zone, p_device uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare pi purchase_invoices; v_rev uuid; r record;
begin
  if p_session_level not in ('A2', 'A3') or p_reauth_at is null or p_reauth_at < now() - interval '5 minutes' then raise exception 'REAUTH_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_purchases') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into pi from purchase_invoices where id = p_invoice and tenant_id = p_tenant for update;
  if pi.id is null then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0001'; end if;
  if pi.status = 'void' then raise exception 'ALREADY_VOID' using errcode = 'P0001'; end if;
  if exists (select 1 from vendor_payment_allocations where purchase_invoice_id = p_invoice) then raise exception 'HAS_PAYMENTS' using errcode = 'P0001'; end if;
  -- D-152: lots can be shared with other bills (same batch, same cost), so the test is whether what
  -- this bill brought in is still free on the shelf of the receiving store, lot by lot.
  if exists (select 1 from (select l.batch_id, sum(l.base_qty + l.free_base_qty) q from purchase_invoice_lines l where l.purchase_id = p_invoice group by l.batch_id) t
               left join stock_balances b on b.tenant_id = p_tenant and b.store_id = pi.received_store_id and b.batch_id = t.batch_id
              where coalesce(b.qty_on_hand - b.qty_reserved, 0) < t.q) then
    raise exception 'LOTS_ALREADY_USED' using errcode = 'P0001';
  end if;
  v_rev := reverse_posting(p_tenant, pi.posting_id, p_idempotency_key, p_by, p_session_level, p_device, 'void ' || pi.purchase_no || ': ' || btrim(p_reason));
  for r in select l.*, ib.unit_cost_base from purchase_invoice_lines l join item_batches ib on ib.id = l.batch_id where l.purchase_id = p_invoice loop
    perform write_movement(p_tenant, pi.received_store_id, r.batch_id, r.item_id, -(r.base_qty + r.free_base_qty), 'purchase_return', r.unit_cost_base,
                           v_rev, 'purchase_invoice', p_invoice, r.id, 'void', p_by);
  end loop;
  update purchase_invoices set status = 'void', void_reason = btrim(p_reason), voided_by = p_by, voided_at = now(), void_posting_id = v_rev where id = p_invoice;
  if pi.po_id is not null then perform po_refresh_status(pi.po_id); end if;
  if exists (select 1 from purchase_returns where purchase_invoice_id = p_invoice) then raise exception 'HAS_RETURNS' using errcode = 'P0001'; end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason)
  values (p_tenant, 'member', p_by, p_session_level, 'purchase.void', 'purchase_invoice', p_invoice::text, 'success', btrim(p_reason));
end $function$;

create or replace function post_purchase_return(p_tenant uuid, p_idempotency_key uuid, p_vendor uuid, p_store uuid, p_invoice uuid, p_settlement text, p_channel text, p_note text, p_lines jsonb, p_by uuid, p_session_level text, p_device uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text; x jsonb; b item_batches; v_pil purchase_invoice_lines;
        v_qty numeric; v_amt numeric; v_tax numeric; v_net numeric := 0; v_taxsum numeric := 0; v_total numeric; v_line uuid; v_left numeric; v_alloc numeric := 0;
        r record; v_out numeric; v_take numeric; v_entries jsonb := '[]'; v_already numeric;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'return_to_vendor') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_store), '') <> 'manage' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  if not exists (select 1 from vendors where id = p_vendor and tenant_id = p_tenant) then raise exception 'VENDOR_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_settlement not in ('credit_note', 'cash_refund', 'online_refund') then raise exception 'BAD_SETTLEMENT' using errcode = 'P0001'; end if;
  if p_settlement = 'online_refund' and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  if p_invoice is not null and not exists (select 1 from purchase_invoices where id = p_invoice and tenant_id = p_tenant and vendor_id = p_vendor and status = 'posted' and kind = 'purchase') then
    raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select bp.posting_id, bp.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'purchase_return', v_id, p_by, p_session_level, p_device) bp;
  if v_replayed then return (select id from purchase_returns where posting_id = v_post); end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'purchase_return', 'PR') d;
  insert into purchase_returns (id, tenant_id, return_no, fiscal_year, vendor_id, purchase_invoice_id, store_id, settlement, online_channel, net_amount, tax_amount, total, note, posted_by, posting_id)
  values (v_id, p_tenant, v_no, v_fy, p_vendor, p_invoice, p_store, p_settlement, case when p_settlement = 'online_refund' then p_channel end, 0, 0, 0, nullif(btrim(p_note), ''), p_by, v_post);

  for x in select * from jsonb_array_elements(p_lines) loop
    select * into b from item_batches where id = (x->>'batch_id')::uuid and tenant_id = p_tenant;
    if b.id is null then raise exception 'LOT_NOT_FOUND' using errcode = 'P0001'; end if;
    if b.vendor_id is distinct from p_vendor then raise exception 'LOT_FROM_ANOTHER_VENDOR' using errcode = 'P0001'; end if;
    if coalesce(x->>'reason', '') not in ('expired', 'near_expiry', 'damaged', 'wrong_item', 'recall', 'excess') then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
    v_qty := round((x->>'qty_base')::numeric, 3);
    if v_qty is null or v_qty <= 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
    if p_invoice is not null then
      -- D-152: a lot can come from several bills; returning against this bill is limited to what it brought.
      select * into v_pil from purchase_invoice_lines where purchase_id = p_invoice and batch_id = b.id order by line_no limit 1;
      if v_pil.id is null then raise exception 'LOT_NOT_ON_THIS_BILL' using errcode = 'P0001'; end if;
      select coalesce(sum(rl.qty_base), 0) into v_already from purchase_return_lines rl join purchase_returns pr on pr.id = rl.return_id
       where rl.batch_id = b.id and pr.purchase_invoice_id = p_invoice;
      if v_qty + v_already > (select sum(base_qty + free_base_qty) from purchase_invoice_lines where purchase_id = p_invoice and batch_id = b.id) then
        raise exception 'MORE_THAN_RECEIVED' using errcode = 'P0001';
      end if;
    else
      select * into v_pil from purchase_invoice_lines where id = b.purchase_invoice_line_id;
    end if;
    v_amt := round(v_qty * b.unit_cost_base, 2);
    v_tax := round(v_amt * coalesce(v_pil.tax_rate, 0) / 100, 2);
    v_line := gen_random_uuid();
    insert into purchase_return_lines (id, tenant_id, return_id, item_id, batch_id, purchase_invoice_line_id, qty_base, unit_cost_base, amount, tax_amount, reason)
    values (v_line, p_tenant, v_id, b.item_id, b.id, v_pil.id, v_qty, b.unit_cost_base, v_amt, v_tax, x->>'reason');
    perform write_movement(p_tenant, p_store, b.id, b.item_id, -v_qty, 'purchase_return', b.unit_cost_base, v_post, 'purchase_return', v_id, v_line, x->>'reason', p_by);
    v_net := v_net + v_amt; v_taxsum := v_taxsum + v_tax;
  end loop;
  v_total := v_net + v_taxsum;
  update purchase_returns set net_amount = v_net, tax_amount = v_taxsum, total = v_total where id = v_id;

  if p_settlement = 'credit_note' then
    v_left := v_total;
    for r in select * from purchase_invoices where tenant_id = p_tenant and vendor_id = p_vendor and status = 'posted' and credit_amount > 0
              order by (id = p_invoice) desc, vendor_invoice_date, posted_at for update loop
      exit when v_left <= 0;
      v_out := purchase_outstanding(r.id);
      continue when v_out <= 0;
      v_take := least(v_out, v_left);
      insert into purchase_return_allocations (tenant_id, return_id, purchase_invoice_id, amount) values (p_tenant, v_id, r.id, v_take);
      v_left := v_left - v_take; v_alloc := v_alloc + v_take;
    end loop;
    if v_alloc > 0 then v_entries := v_entries || jsonb_build_object('account', 'AP_VENDORS', 'debit', v_alloc, 'vendor_id', p_vendor, 'memo', v_no || ' credit note'); end if;
    if v_left > 0 then v_entries := v_entries || jsonb_build_object('account', 'VENDOR_ADVANCES', 'debit', v_left, 'vendor_id', p_vendor, 'memo', v_no || ' credit note (unused)'); end if;
  elsif p_settlement = 'cash_refund' then
    v_entries := v_entries || jsonb_build_object('account', 'CASH', 'debit', v_total, 'channel', 'cash', 'vendor_id', p_vendor, 'memo', v_no || ' refund');
  else
    v_entries := v_entries || jsonb_build_object('account', 'BANK', 'debit', v_total, 'channel', p_channel, 'vendor_id', p_vendor, 'memo', v_no || ' refund');
  end if;
  v_entries := v_entries || jsonb_build_object('account', 'INVENTORY', 'credit', v_net, 'store_id', p_store, 'vendor_id', p_vendor, 'memo', v_no);
  if v_taxsum > 0 then v_entries := v_entries || jsonb_build_object('account', 'TAX_RECEIVABLE', 'credit', v_taxsum, 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_total > 0 then perform post_journal(p_tenant, v_post, v_entries); end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'purchase.return', 'purchase_return', v_id::text, 'success',
          jsonb_build_object('no', v_no, 'vendor', p_vendor, 'total', v_total, 'settlement', p_settlement));
  return v_id;
end $function$;
