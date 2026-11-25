-- =============================================================================
-- 0061 PURCHASING GAPS (pharmacy track, step 2). Decision D-143.
--  1. A vendor's credit (payments beyond their bills, unused credit notes) is used on their
--     open bills, oldest credit and oldest bill first: allocations on the existing documents
--     plus one posting Dr AP_VENDORS / Cr VENDOR_ADVANCES. The nightly payables check reads
--     the same documents, so it stays in step.
--  2. Found stock gets a proper lot: batch number in capitals, batch and expiry required for
--     medicines, an MRP and sale price (it used to sell at cost), never above the MRP.
--  (Per-store reorder levels need no database change: store_item_levels is already the app's.)
-- =============================================================================

create or replace function apply_vendor_credit(p_tenant uuid, p_idempotency_key uuid, p_vendor uuid, p_by uuid, p_session_level text, p_device uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; s record; b record; v_src_left numeric; v_out numeric; v_take numeric;
        v_total numeric := 0; v_bills uuid[] := '{}'; v_name text;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'pay_vendors') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  select name into v_name from vendors where id = p_vendor and tenant_id = p_tenant;
  if v_name is null then raise exception 'VENDOR_NOT_FOUND' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('vendor:' || p_vendor::text, 0));
  select bp.posting_id, bp.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'vendor_credit', v_id, p_by, p_session_level, p_device) bp;
  if v_replayed then return jsonb_build_object('replayed', true); end if;

  for s in
    select 'payment' kind, vp.id, vp.paid_at at, vp.amount - coalesce((select sum(a.amount) from vendor_payment_allocations a where a.vendor_payment_id = vp.id), 0) left_amt
      from vendor_payments vp where vp.tenant_id = p_tenant and vp.vendor_id = p_vendor
    union all
    select 'credit_note', pr.id, pr.posted_at, pr.total - coalesce((select sum(a.amount) from purchase_return_allocations a where a.return_id = pr.id), 0)
      from purchase_returns pr where pr.tenant_id = p_tenant and pr.vendor_id = p_vendor and pr.settlement = 'credit_note'
    order by 3
  loop
    continue when s.left_amt <= 0;
    v_src_left := s.left_amt;
    for b in select pi.id from purchase_invoices pi where pi.tenant_id = p_tenant and pi.vendor_id = p_vendor and pi.status = 'posted' and pi.credit_amount > 0
              order by pi.vendor_invoice_date, pi.posted_at for update loop
      exit when v_src_left <= 0;
      v_out := purchase_outstanding(b.id);
      continue when v_out <= 0;
      v_take := least(v_out, v_src_left);
      if s.kind = 'payment' then
        insert into vendor_payment_allocations (tenant_id, vendor_payment_id, purchase_invoice_id, amount) values (p_tenant, s.id, b.id, v_take);
      else
        insert into purchase_return_allocations (tenant_id, return_id, purchase_invoice_id, amount) values (p_tenant, s.id, b.id, v_take);
      end if;
      v_src_left := v_src_left - v_take; v_total := v_total + v_take;
      if not b.id = any (v_bills) then v_bills := v_bills || b.id; end if;
    end loop;
  end loop;
  if v_total <= 0 then raise exception 'NOTHING_TO_APPLY' using errcode = 'P0001'; end if;
  perform post_journal(p_tenant, v_post, jsonb_build_array(
    jsonb_build_object('account', 'AP_VENDORS', 'debit', v_total, 'vendor_id', p_vendor, 'memo', 'Credit used: ' || left(v_name, 60)),
    jsonb_build_object('account', 'VENDOR_ADVANCES', 'credit', v_total, 'vendor_id', p_vendor, 'memo', 'Credit used: ' || left(v_name, 60))));
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'vendor.credit_applied', 'vendor', p_vendor::text, 'success',
          jsonb_build_object('amount', v_total, 'bills', cardinality(v_bills)));
  return jsonb_build_object('applied', v_total, 'bills', cardinality(v_bills), 'replayed', false);
end $$;


-- ── adjustments: as in 0035, found lots made properly ───────────────────────────
create or replace function post_stock_adjustment(p_tenant uuid, p_idempotency_key uuid, p_store uuid, p_reason text, p_note text, p_lines jsonb,
                                                 p_by uuid, p_session_level text, p_device uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text; x jsonb; v_b item_batches; v_unit item_units;
        v_qty numeric; v_line uuid; v_loss numeric := 0; v_gain numeric := 0; v_entries jsonb := '[]';
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_stock') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_store), '') <> 'manage' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  if p_reason not in ('damaged', 'expired', 'lost', 'theft', 'found', 'correction', 'internal_use', 'sample') then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'stock_adjustment', v_id, p_by, p_session_level, p_device) b;
  if v_replayed then return (select id from stock_adjustments where posting_id = v_post); end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'adjustment', 'ADJ') d;
  insert into stock_adjustments (id, tenant_id, adj_no, fiscal_year, store_id, reason_code, note, posted_by, posting_id)
  values (v_id, p_tenant, v_no, v_fy, p_store, p_reason, nullif(btrim(p_note), ''), p_by, v_post);

  for x in select * from jsonb_array_elements(p_lines) loop
    if nullif(x->>'batch_id', '') is not null then
      select * into v_b from item_batches where id = (x->>'batch_id')::uuid and tenant_id = p_tenant;
      if v_b.id is null then raise exception 'LOT_NOT_FOUND' using errcode = 'P0001'; end if;
      v_qty := round((x->>'qty_base')::numeric, 3);
    else
      if p_reason <> 'found' then raise exception 'LOT_REQUIRED' using errcode = 'P0001'; end if;
      select u.* into v_unit from item_units u join inventory_items it on it.id = u.item_id and it.tenant_id = p_tenant
       where u.id = (x->>'unit_id')::uuid and u.item_id = (x->>'item_id')::uuid;
      if v_unit.id is null then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0001'; end if;
      -- D-143: a found lot is a real lot: batch and expiry for medicines, an MRP and sale price.
      if exists (select 1 from inventory_items where id = v_unit.item_id and item_type = 'medicine') then
        if coalesce(btrim(x->>'batch_no'), '') = '' then raise exception 'BATCH_REQUIRED' using errcode = 'P0001'; end if;
        if nullif(x->>'expiry_date', '') is null then raise exception 'EXPIRY_REQUIRED' using errcode = 'P0001'; end if;
      end if;
      if nullif(x->>'mrp', '') is not null and coalesce(nullif(x->>'sale_price', '')::numeric, (x->>'mrp')::numeric) > (x->>'mrp')::numeric then
        raise exception 'PRICE_ABOVE_MRP' using errcode = 'P0001';
      end if;
      insert into item_batches (tenant_id, item_id, batch_no, expiry_date, source, unit_cost_base, mrp_base, sale_price_base)
      values (p_tenant, v_unit.item_id, upper(regexp_replace(btrim(coalesce(nullif(btrim(x->>'batch_no'), ''), 'NA')), '\s+', '', 'g')), nullif(x->>'expiry_date', '')::date, 'found',
              round(coalesce((x->>'unit_cost')::numeric, 0) / v_unit.factor_to_base, 4),
              round(nullif(x->>'mrp', '')::numeric / v_unit.factor_to_base, 4),
              round(coalesce(nullif(x->>'sale_price', '')::numeric, nullif(x->>'mrp', '')::numeric, coalesce((x->>'unit_cost')::numeric, 0)) / v_unit.factor_to_base, 4))
      returning * into v_b;
      v_qty := round((x->>'qty')::numeric * v_unit.factor_to_base, 3);
    end if;
    if v_qty is null or v_qty = 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
    if p_reason = 'found' and v_qty < 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
    if p_reason in ('damaged', 'expired', 'lost', 'theft', 'internal_use', 'sample') and v_qty > 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
    v_line := gen_random_uuid();
    insert into stock_adjustment_lines (id, tenant_id, adjustment_id, item_id, batch_id, qty_base, unit_cost_base)
    values (v_line, p_tenant, v_id, v_b.item_id, v_b.id, v_qty, v_b.unit_cost_base);
    perform write_movement(p_tenant, p_store, v_b.id, v_b.item_id, v_qty, case when v_qty > 0 then 'adjustment_in' else 'adjustment_out' end,
                           v_b.unit_cost_base, v_post, 'stock_adjustment', v_id, v_line, p_reason, p_by);
    if v_qty > 0 then v_gain := v_gain + round(v_qty * v_b.unit_cost_base, 2); else v_loss := v_loss + round(-v_qty * v_b.unit_cost_base, 2); end if;
  end loop;
  if v_loss > 0 then v_entries := v_entries || jsonb_build_object('account', 'INV_LOSS', 'debit', v_loss, 'store_id', p_store, 'memo', v_no || ' ' || p_reason)
                                            || jsonb_build_object('account', 'INVENTORY', 'credit', v_loss, 'store_id', p_store, 'memo', v_no); end if;
  if v_gain > 0 then v_entries := v_entries || jsonb_build_object('account', 'INVENTORY', 'debit', v_gain, 'store_id', p_store, 'memo', v_no)
                                            || jsonb_build_object('account', 'INV_GAIN', 'credit', v_gain, 'store_id', p_store, 'memo', v_no || ' ' || p_reason); end if;
  if jsonb_array_length(v_entries) > 0 then perform post_journal(p_tenant, v_post, v_entries); end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'stock.adjust', 'stock_adjustment', v_id::text, 'success', jsonb_build_object('no', v_no, 'reason', p_reason, 'loss', v_loss, 'gain', v_gain));
  return v_id;
end $$;


-- ── ownership and privileges ──────────────────────────────────────────────────
grant select on vendors to ledger_writer;
grant insert on purchase_return_allocations to ledger_writer;
grant create on schema public to ledger_writer;
alter function apply_vendor_credit(uuid, uuid, uuid, uuid, text, uuid) owner to ledger_writer;
revoke create on schema public from ledger_writer;
revoke all on function apply_vendor_credit(uuid, uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function apply_vendor_credit(uuid, uuid, uuid, uuid, text, uuid) to service_role;
