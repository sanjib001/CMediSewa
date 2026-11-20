-- =============================================================================
-- 0043 PURCHASING II (B6b): purchase orders (received quantities derived from the bills that
-- reference them), purchase returns settled by credit note or refund (credit notes settle
-- open bills oldest first, remainder = vendor advance), and the payable check: what the
-- journal says each vendor is owed = what the documents say. database.md §10; D-94..D-96.
-- =============================================================================

-- ── purchase orders ───────────────────────────────────────────────────────────
create table purchase_orders (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants (id) on delete restrict,
  po_no                text not null,
  fiscal_year          text not null,
  vendor_id            uuid not null,
  deliver_to_store_id  uuid not null,
  status               text not null default 'open' check (status in ('open', 'partially_received', 'received', 'closed', 'cancelled')),
  expected_date        date,
  note                 text check (length(note) <= 300),
  created_by           uuid not null,
  created_at           timestamptz not null default now(),
  closed_reason        text,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_year, po_no),
  foreign key (tenant_id, vendor_id) references vendors (tenant_id, id),
  foreign key (tenant_id, deliver_to_store_id) references stores (tenant_id, id),
  foreign key (tenant_id, created_by) references tenant_members (tenant_id, id)
);
create table purchase_order_lines (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  po_id                uuid not null,
  line_no              smallint not null,
  item_id              uuid not null,
  unit_id              uuid not null,
  qty                  numeric(14,3) not null check (qty > 0),
  factor_snapshot      numeric(14,4) not null check (factor_snapshot > 0),
  base_qty             numeric(14,3) generated always as (round(qty * factor_snapshot, 3)) stored,
  expected_unit_cost   numeric(14,4) check (expected_unit_cost >= 0),
  unique (tenant_id, id),
  unique (po_id, line_no),
  foreign key (tenant_id, po_id) references purchase_orders (tenant_id, id),
  foreign key (tenant_id, item_id, unit_id) references item_units (tenant_id, item_id, id)
);
alter table purchase_invoice_lines add column po_line_id uuid;
alter table purchase_invoice_lines add constraint purchase_invoice_lines_po_line_fk foreign key (tenant_id, po_line_id) references purchase_order_lines (tenant_id, id);
alter table purchase_invoices add column po_id uuid;
alter table purchase_invoices add constraint purchase_invoices_po_fk foreign key (tenant_id, po_id) references purchase_orders (tenant_id, id);

-- ── purchase returns ─────────────────────────────────────────────────────────
create table purchase_returns (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants (id) on delete restrict,
  return_no            text not null,
  fiscal_year          text not null,
  vendor_id            uuid not null,
  purchase_invoice_id  uuid,
  store_id             uuid not null,
  settlement           text not null check (settlement in ('credit_note', 'cash_refund', 'online_refund')),
  online_channel       text check (online_channel in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')),
  net_amount           numeric(14,2) not null check (net_amount >= 0),
  tax_amount           numeric(14,2) not null default 0 check (tax_amount >= 0),
  total                numeric(14,2) not null check (total >= 0),
  note                 text check (length(note) <= 300),
  posted_by            uuid not null,
  posted_at            timestamptz not null default now(),
  posting_id           uuid not null,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_year, return_no),
  foreign key (tenant_id, vendor_id) references vendors (tenant_id, id),
  foreign key (tenant_id, purchase_invoice_id) references purchase_invoices (tenant_id, id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, posted_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  check (total = net_amount + tax_amount),
  check ((settlement = 'online_refund') = (online_channel is not null))
);
create table purchase_return_lines (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null,
  return_id                 uuid not null,
  item_id                   uuid not null,
  batch_id                  uuid not null,
  purchase_invoice_line_id  uuid,
  qty_base                  numeric(14,3) not null check (qty_base > 0),
  unit_cost_base            numeric(14,4) not null,
  amount                    numeric(14,2) not null,
  tax_amount                numeric(14,2) not null default 0,
  reason                    text not null check (reason in ('expired', 'near_expiry', 'damaged', 'wrong_item', 'recall', 'excess')),
  unique (tenant_id, id),
  foreign key (tenant_id, return_id) references purchase_returns (tenant_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id),
  foreign key (tenant_id, purchase_invoice_line_id) references purchase_invoice_lines (tenant_id, id)
);
-- A credit note settles open bills (like a payment): Σ ≤ the note, per bill ≤ outstanding.
create table purchase_return_allocations (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  return_id            uuid not null,
  purchase_invoice_id  uuid not null,
  amount               numeric(14,2) not null check (amount > 0),
  unique (tenant_id, id),
  foreign key (tenant_id, return_id) references purchase_returns (tenant_id, id),
  foreign key (tenant_id, purchase_invoice_id) references purchase_invoices (tenant_id, id)
);
create index purchase_return_allocations_invoice on purchase_return_allocations (purchase_invoice_id);

create table payable_reconciliations (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants (id) on delete restrict,
  ran_at      timestamptz not null default now(),
  vendors     integer not null,
  mismatches  integer not null,
  details     jsonb
);

alter table purchase_orders              enable row level security;
alter table purchase_order_lines         enable row level security;
alter table purchase_returns             enable row level security;
alter table purchase_return_lines        enable row level security;
alter table purchase_return_allocations  enable row level security;
alter table payable_reconciliations      enable row level security;
revoke insert, update, delete on purchase_orders, purchase_order_lines, purchase_returns, purchase_return_lines, purchase_return_allocations, payable_reconciliations from service_role;
revoke usage on sequence payable_reconciliations_id_seq from service_role;

-- What a bill still owes: credit part − payments − credit notes applied to it.
create or replace function purchase_outstanding(p_invoice uuid)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  select case when pi.status = 'void' then 0 else pi.credit_amount
           - coalesce((select sum(a.amount) from vendor_payment_allocations a where a.purchase_invoice_id = pi.id), 0)
           - coalesce((select sum(a.amount) from purchase_return_allocations a where a.purchase_invoice_id = pi.id), 0) end
    from purchase_invoices pi where pi.id = p_invoice;
$$;

-- Received so far on an order line (paid quantity of non-void bills referencing it).
create or replace function po_line_received(p_line uuid)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce(sum(l.base_qty), 0) from purchase_invoice_lines l join purchase_invoices pi on pi.id = l.purchase_id
   where l.po_line_id = p_line and pi.status = 'posted';
$$;

create or replace function po_refresh_status(p_po uuid)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_status text; v_any boolean; v_all boolean;
begin
  select status into v_status from purchase_orders where id = p_po for update;
  if v_status in ('closed', 'cancelled') then return; end if;
  select bool_or(po_line_received(id) > 0), bool_and(po_line_received(id) >= base_qty) into v_any, v_all from purchase_order_lines where po_id = p_po;
  update purchase_orders set status = case when v_all then 'received' when v_any then 'partially_received' else 'open' end where id = p_po;
end $$;

-- p_lines: [{ item_id, unit_id, qty, expected_unit_cost }]
create or replace function create_purchase_order(p_tenant uuid, p_by uuid, p_vendor uuid, p_store uuid, p_expected date, p_note text, p_lines jsonb)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_fy text; v_no text; l jsonb; n integer := 0; v_unit item_units;
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_purchases') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if not exists (select 1 from vendors where id = p_vendor and tenant_id = p_tenant and is_active) then raise exception 'VENDOR_NOT_FOUND' using errcode = 'P0001'; end if;
  if not exists (select 1 from stores where id = p_store and tenant_id = p_tenant and is_active and is_receiving) then raise exception 'STORE_NOT_RECEIVING' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'purchase_order', 'PO') d;
  insert into purchase_orders (id, tenant_id, po_no, fiscal_year, vendor_id, deliver_to_store_id, expected_date, note, created_by)
  values (v_id, p_tenant, v_no, v_fy, p_vendor, p_store, p_expected, nullif(btrim(p_note), ''), p_by);
  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    select u.* into v_unit from item_units u join inventory_items i on i.id = u.item_id and i.tenant_id = p_tenant
     where u.id = (l->>'unit_id')::uuid and u.item_id = (l->>'item_id')::uuid;
    if v_unit.id is null then raise exception 'ITEM_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'BAD_QTY: line %', n using errcode = 'P0001'; end if;
    insert into purchase_order_lines (tenant_id, po_id, line_no, item_id, unit_id, qty, factor_snapshot, expected_unit_cost)
    values (p_tenant, v_id, n, v_unit.item_id, v_unit.id, (l->>'qty')::numeric, v_unit.factor_to_base, nullif(l->>'expected_unit_cost', '')::numeric);
  end loop;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, 'po.create', 'purchase_order', v_id::text, 'success', jsonb_build_object('no', v_no, 'vendor', p_vendor, 'lines', n));
  return v_id;
end $$;

-- Cancel (nothing received yet) or close (stop waiting for the rest).
create or replace function end_purchase_order(p_tenant uuid, p_by uuid, p_po uuid, p_action text, p_reason text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare po purchase_orders;
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_purchases') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  select * into po from purchase_orders where id = p_po and tenant_id = p_tenant for update;
  if po.id is null then raise exception 'PO_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_action = 'cancel' then
    if po.status <> 'open' then raise exception 'PO_HAS_RECEIPTS' using errcode = 'P0001'; end if;
  elsif p_action = 'close' then
    if po.status not in ('open', 'partially_received') then raise exception 'PO_NOT_OPEN' using errcode = 'P0001'; end if;
  else raise exception 'BAD_ACTION' using errcode = 'P0001';
  end if;
  update purchase_orders set status = case when p_action = 'cancel' then 'cancelled' else 'closed' end, closed_reason = nullif(btrim(p_reason), '') where id = p_po;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, reason)
  values (p_tenant, 'member', p_by, 'po.' || p_action, 'purchase_order', p_po::text, 'success', nullif(btrim(p_reason), ''));
end $$;

-- Return stock to the vendor it was bought from (W-44). Only lots bought from this vendor; if a
-- bill is named, only its lots and no more than it brought in minus earlier returns. Blocked
-- and expired lots CAN go back. Value = lot cost (+ the input VAT paid on it, reversed).
--   credit note: Dr AP_VENDORS (settles open bills oldest first) + Dr VENDOR_ADVANCES (rest)
--   refund:      Dr CASH / BANK
--   and always:  Cr INVENTORY (lot cost) + Cr TAX_RECEIVABLE (its VAT)
-- p_lines: [{ batch_id, qty_base, reason }]
create or replace function post_purchase_return(p_tenant uuid, p_idempotency_key uuid, p_vendor uuid, p_store uuid, p_invoice uuid, p_settlement text,
                                                p_channel text, p_note text, p_lines jsonb, p_by uuid, p_session_level text, p_device uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
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
    select * into v_pil from purchase_invoice_lines where id = b.purchase_invoice_line_id;
    if p_invoice is not null then
      if v_pil.purchase_id is distinct from p_invoice then raise exception 'LOT_NOT_ON_THIS_BILL' using errcode = 'P0001'; end if;
      select coalesce(sum(qty_base), 0) into v_already from purchase_return_lines where batch_id = b.id;
      if v_qty + v_already > v_pil.base_qty + v_pil.free_base_qty then raise exception 'MORE_THAN_RECEIVED' using errcode = 'P0001'; end if;
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
end $$;

-- The payable check: for every vendor, the journal (AP_VENDORS, VENDOR_ADVANCES) must equal the
-- documents (bills' outstanding; payments and credit notes not applied to any bill). The journal
-- is never "repaired": a difference is recorded and audited for a person to investigate.
create or replace function reconcile_vendor_payables(p_tenant uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_bad jsonb; v_n integer; v_count integer;
begin
  with docs as (
    select v.id vendor_id,
      coalesce((select sum(purchase_outstanding(pi.id)) from purchase_invoices pi where pi.vendor_id = v.id), 0) owed,
      coalesce((select sum(vp.amount - coalesce((select sum(a.amount) from vendor_payment_allocations a where a.vendor_payment_id = vp.id), 0)) from vendor_payments vp where vp.vendor_id = v.id), 0)
      + coalesce((select sum(pr.total - coalesce((select sum(a.amount) from purchase_return_allocations a where a.return_id = pr.id), 0)) from purchase_returns pr where pr.vendor_id = v.id and pr.settlement = 'credit_note'), 0) advance
      from vendors v where v.tenant_id = p_tenant),
  j as (select vendor_id, payable, advance from vendor_balances(p_tenant))
  select count(*), coalesce(jsonb_agg(jsonb_build_object('vendor_id', d.vendor_id, 'documents_owed', d.owed, 'journal_owed', j.payable, 'documents_advance', d.advance, 'journal_advance', j.advance))
                         filter (where d.owed <> j.payable or d.advance <> j.advance), '[]')
    into v_count, v_bad from docs d join j on j.vendor_id = d.vendor_id;
  v_n := jsonb_array_length(v_bad);
  insert into payable_reconciliations (tenant_id, vendors, mismatches, details) values (p_tenant, v_count, v_n, nullif(v_bad, '[]'::jsonb));
  if v_n > 0 then
    insert into audit_log (tenant_id, actor_kind, action, target_type, outcome, reason, detail)
    values (p_tenant, 'system', 'payable.reconcile', 'tenant', 'error', 'payable_mismatch', jsonb_build_object('mismatches', v_bad));
  end if;
  return jsonb_build_object('vendors', v_count, 'mismatches', v_n);
end $$;

-- Nightly: stock balances AND vendor payables, every live clinic.
create or replace function reconcile_all_tenants()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare t uuid; r jsonb; p jsonb; v_out jsonb := '[]'; v_total integer := 0; v_pay integer := 0;
begin
  for t in select id from tenants where status in ('active', 'pending') loop
    r := reconcile_stock_balances(t, null);
    p := reconcile_vendor_payables(t);
    v_total := v_total + (r->>'mismatches')::integer;
    v_pay := v_pay + (p->>'mismatches')::integer;
    if (r->>'mismatches')::integer > 0 or (p->>'mismatches')::integer > 0 then
      v_out := v_out || jsonb_build_object('tenant', t, 'mismatches', r->'mismatches', 'payable_mismatches', p->'mismatches');
    end if;
  end loop;
  return jsonb_build_object('mismatches', v_total, 'payable_mismatches', v_pay, 'tenants', v_out);
end $$;

-- ── bills now link to order lines (same function, two additions) ─────────────
create or replace function post_purchase_invoice(
  p_tenant uuid, p_idempotency_key uuid, p_vendor uuid, p_vendor_invoice_no text, p_vendor_invoice_date date, p_store uuid,
  p_lines jsonb, p_bill_discount numeric, p_round_off numeric, p_paid_cash numeric, p_paid_online numeric, p_online_channel text, p_note text,
  p_by uuid, p_session_level text, p_device uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text; v_set tenant_settings; l jsonb; n integer := 0;
  v_unit item_units; v_item inventory_items; v_gross numeric; v_disc numeric; v_net numeric; v_tax numeric;
  v_sub numeric := 0; v_ldisc numeric := 0; v_taxable numeric := 0; v_taxsum numeric := 0; v_total numeric; v_bill numeric := round(coalesce(p_bill_discount, 0), 2);
  v_round numeric := round(coalesce(p_round_off, 0), 2); v_cash numeric := round(coalesce(p_paid_cash, 0), 2); v_online numeric := round(coalesce(p_paid_online, 0), 2);
  v_credit numeric; v_line uuid; v_batch uuid; v_qb numeric; v_fb numeric; v_cost_base numeric; v_inv_value numeric := 0; v_entries jsonb := '[]';
  r record; v_share numeric; v_today date; v_po_line uuid; v_pol purchase_order_lines; v_po uuid;
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
    -- the lot is created now; its cost is finalised below once the bill discount is spread
    insert into item_batches (tenant_id, item_id, batch_no, mfg_date, expiry_date, source, vendor_id, unit_cost_base, mrp_base, sale_price_base)
    values (p_tenant, v_item.id, upper(btrim(coalesce(nullif(l->>'batch_no', ''), case when v_item.item_type = 'medicine' then null else 'NA' end))),
            nullif(l->>'mfg_date', '')::date, nullif(l->>'expiry_date', '')::date, 'purchase', p_vendor, 0,
            round(nullif(l->>'mrp', '')::numeric / v_unit.factor_to_base, 4),
            round(coalesce(nullif(l->>'sale_price', '')::numeric, nullif(l->>'mrp', '')::numeric, coalesce((l->>'unit_cost')::numeric, 0)) / v_unit.factor_to_base, 4))
    returning id into v_batch;
    insert into purchase_invoice_lines (id, tenant_id, purchase_id, line_no, item_id, unit_id, qty, free_qty, factor_snapshot, unit_cost, discount_pct, discount_amount,
                                        tax_rate, tax_amount, line_net, batch_no, mfg_date, expiry_date, mrp, sale_price, batch_id, po_line_id)
    values (v_line, p_tenant, v_id, n, v_item.id, v_unit.id, (l->>'qty')::numeric, coalesce((l->>'free_qty')::numeric, 0), v_unit.factor_to_base,
            coalesce((l->>'unit_cost')::numeric, 0), coalesce((l->>'discount_pct')::numeric, 0), v_disc, coalesce((l->>'tax_rate')::numeric, 0), v_tax, v_net,
            upper(btrim(coalesce(nullif(l->>'batch_no', ''), 'NA'))), nullif(l->>'mfg_date', '')::date, nullif(l->>'expiry_date', '')::date,
            nullif(l->>'mrp', '')::numeric, nullif(l->>'sale_price', '')::numeric, v_batch, v_po_line);
    update item_batches set purchase_invoice_line_id = v_line where id = v_batch;
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
    update item_batches set unit_cost_base = v_cost_base where id = r.batch_id;
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
end $$;

create or replace function void_purchase_invoice(p_tenant uuid, p_idempotency_key uuid, p_invoice uuid, p_reason text, p_by uuid, p_session_level text,
                                                 p_reauth_at timestamptz, p_device uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
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
  if exists (select 1 from stock_movements m join purchase_invoice_lines l on l.batch_id = m.batch_id
              where l.purchase_id = p_invoice and not (m.doc_type = 'purchase_invoice' and m.doc_id = p_invoice)) then
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
end $$;

-- ── ownership and privileges ──────────────────────────────────────────────────
grant select on purchase_orders, purchase_order_lines, purchase_returns, purchase_return_lines, purchase_return_allocations to ledger_writer;
grant insert, update on purchase_orders to ledger_writer;
grant insert on purchase_order_lines, purchase_returns, purchase_return_lines, purchase_return_allocations, payable_reconciliations to ledger_writer;
grant update (net_amount, tax_amount, total) on purchase_returns to ledger_writer;
grant update (po_id) on purchase_invoices to ledger_writer;
grant usage, select on sequence payable_reconciliations_id_seq to ledger_writer;
grant execute on function purchase_outstanding(uuid), po_line_received(uuid) to ledger_writer;
grant execute on function vendor_balances(uuid) to ledger_writer;
grant select on ledger_entries to ledger_writer;
grant create on schema public to ledger_writer;
alter function po_refresh_status(uuid) owner to ledger_writer;
alter function create_purchase_order(uuid, uuid, uuid, uuid, date, text, jsonb) owner to ledger_writer;
alter function end_purchase_order(uuid, uuid, uuid, text, text) owner to ledger_writer;
alter function post_purchase_return(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, uuid, text, uuid) owner to ledger_writer;
alter function reconcile_vendor_payables(uuid) owner to ledger_writer;
revoke create on schema public from ledger_writer;

revoke all on function po_refresh_status(uuid) from public, anon, authenticated, service_role;
revoke all on function po_line_received(uuid) from public, anon, authenticated;
grant execute on function po_line_received(uuid) to service_role;
do $$
declare f text;
begin
  foreach f in array array[
    'create_purchase_order(uuid, uuid, uuid, uuid, date, text, jsonb)', 'end_purchase_order(uuid, uuid, uuid, text, text)',
    'post_purchase_return(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, uuid, text, uuid)', 'reconcile_vendor_payables(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
