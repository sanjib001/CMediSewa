-- =============================================================================
-- 0062 PURCHASE PLANNING AND SUPPLIER PERFORMANCE (M-46, pharmacy track step 3). D-144.
--  1. purchase_plan: what each receiving store should order, from how fast it really uses each
--     item (sales net of returns plus what it sends to other stores, over a window), the
--     vendor's delivery time and the days of stock to keep, as well as the reorder levels.
--  2. vendor_performance: fill rate, on-time rate, delivery days, return rate, price changes
--     and shelf life at receipt, from the clinic's own orders, bills and returns.
--  3. A purchase order above the clinic's approval limit waits for someone who manages the
--     settings (normally the owner); until approved it can't be received against.
-- =============================================================================

alter table tenant_settings add column po_approval_limit numeric(14,2) check (po_approval_limit is null or po_approval_limit > 0),
                            add column reorder_cover_days smallint not null default 30 check (reorder_cover_days between 7 and 120);
alter table vendors add column lead_time_days smallint check (lead_time_days between 1 and 120);

alter table purchase_orders drop constraint purchase_orders_status_check;
alter table purchase_orders add constraint purchase_orders_status_check
  check (status in ('pending_approval', 'open', 'partially_received', 'received', 'closed', 'cancelled'));
alter table purchase_orders add column approved_by uuid, add column approved_at timestamptz;
alter table purchase_orders add constraint purchase_orders_approved_by_fk foreign key (tenant_id, approved_by) references tenant_members (tenant_id, id);

-- Expected value of an order (lines with an expected cost).
create or replace function po_expected_total(p_po uuid)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$ select coalesce(sum(qty * expected_unit_cost), 0) from purchase_order_lines where po_id = p_po; $$;

-- A vendor's delivery time in days: as set on the vendor, else the average from its orders
-- (order → first bill), else 7.
create or replace function vendor_lead_days(p_tenant uuid, p_vendor uuid)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce((select lead_time_days from vendors where id = p_vendor and tenant_id = p_tenant)::numeric,
                  (select round(avg(extract(epoch from (fb.first_at - po.created_at)) / 86400)::numeric, 1)
                     from purchase_orders po
                     cross join lateral (select min(pi.posted_at) first_at from purchase_invoices pi where pi.po_id = po.id and pi.status = 'posted') fb
                    where po.tenant_id = p_tenant and po.vendor_id = p_vendor and fb.first_at is not null and po.created_at > now() - interval '365 days'),
                  7);
$$;

-- What to order. One row per receiving store and item that is running low, either by its
-- levels or because, at its recent rate of use, it won't last until a delivery arrives plus a
-- week. The quantity covers the delivery time plus the clinic's cover days (default 30), or
-- the item's levels if that is more, less what is on hand and already on order.
create or replace function purchase_plan(p_tenant uuid, p_store uuid default null, p_days integer default 30)
returns table (store_id uuid, store_name text, item_id uuid, item_name text, vendor_id uuid, vendor_name text,
               on_hand numeric, on_order numeric, used numeric, per_day numeric, days_left numeric, lead_days numeric,
               reorder_level numeric, suggested_base numeric, purchase_unit_id uuid, purchase_unit text, unit_factor numeric,
               suggested_units numeric, last_unit_cost_base numeric, est_cost numeric, reason text)
language sql stable
set search_path = pg_catalog, public
as $$
  with s as (
    select st.id, st.name from stores st
     where st.tenant_id = p_tenant and st.is_active and st.is_receiving and st.kind <> 'quarantine' and (p_store is null or st.id = p_store)),
  win as (select greatest(least(coalesce(p_days, 30), 365), 7) d),
  base as (
    select s.id store_id, s.name store_name, i.id item_id, i.name item_name,
           coalesce((select sum(b.qty_on_hand) from stock_balances b join item_batches ib on ib.id = b.batch_id
                      where b.store_id = s.id and b.item_id = i.id and ib.status = 'active' and (ib.expiry_date is null or ib.expiry_date > current_date)), 0) on_hand,
           coalesce((select sum(greatest(pol.base_qty - po_line_received(pol.id), 0)) from purchase_order_lines pol join purchase_orders po on po.id = pol.po_id
                      where po.deliver_to_store_id = s.id and pol.item_id = i.id and po.status in ('pending_approval', 'open', 'partially_received')), 0) on_order,
           coalesce((select -sum(m.qty_base) from stock_movements m
                      where m.store_id = s.id and m.item_id = i.id and m.kind in ('sale', 'sale_return', 'transfer_out')
                        and m.occurred_at > now() - make_interval(days => (select d from win))), 0) used,
           (select pi.vendor_id from purchase_invoice_lines pl join purchase_invoices pi on pi.id = pl.purchase_id
             where pl.item_id = i.id and pi.tenant_id = p_tenant and pi.status = 'posted' and pi.kind <> 'opening'
             order by pi.posted_at desc limit 1) vendor_id
      from s cross join inventory_items i
     where i.tenant_id = p_tenant and i.is_active and i.deleted_at is null),
  calc as (
    select b.*, greatest(b.used, 0) / (select d from win) per_day, lv.reorder_level rl, lv.max_level ml, lv.reorder_qty rq,
           vendor_lead_days(p_tenant, b.vendor_id) lead,
           (select reorder_cover_days from tenant_settings where tenant_id = p_tenant) cover
      from base b cross join lateral item_levels(p_tenant, b.store_id, b.item_id) lv),
  need as (
    select c.*,
           case when c.rl is not null and c.on_hand + c.on_order <= c.rl then 'level'
                when c.per_day > 0 and c.on_hand + c.on_order < c.per_day * (c.lead + 7) then 'sales' end why,
           greatest(ceil(c.per_day * (c.lead + c.cover)), coalesce(c.ml, 0), coalesce(c.rl * 2, 0), coalesce(c.rq, 0)) - c.on_hand - c.on_order qty
      from calc c),
  unit as (
    select n.*, coalesce(u_def.id, u_big.id) uid, coalesce(u_def.name, u_big.name, 'unit') uname, coalesce(u_def.factor_to_base, u_big.factor_to_base, 1) f,
           (select ib.unit_cost_base from item_batches ib where ib.item_id = n.item_id and ib.source = 'purchase' order by ib.created_at desc limit 1) cost
      from need n
      join inventory_items i on i.id = n.item_id
      left join item_units u_def on u_def.id = i.default_purchase_unit_id
      left join lateral (select id, name, factor_to_base from item_units where item_id = n.item_id and can_purchase order by factor_to_base desc limit 1) u_big on true
     where n.why is not null and n.qty > 0)
  select u.store_id, u.store_name, u.item_id, u.item_name, u.vendor_id, v.name, u.on_hand, u.on_order, greatest(u.used, 0), round(u.per_day, 2),
         case when u.per_day > 0 then round(u.on_hand / u.per_day, 1) end, u.lead, u.rl, u.qty, u.uid, u.uname, u.f,
         ceil(u.qty / nullif(u.f, 0)), u.cost, round(ceil(u.qty / nullif(u.f, 0)) * u.f * coalesce(u.cost, 0), 2), u.why
    from unit u left join vendors v on v.id = u.vendor_id
   order by (u.why = 'level') desc, case when u.per_day > 0 then u.on_hand / u.per_day end nulls last, u.item_name;
$$;

-- How a vendor has done over the last p_days (default a year).
create or replace function vendor_performance(p_tenant uuid, p_vendor uuid, p_days integer default 365)
returns jsonb
language sql stable
set search_path = pg_catalog, public
as $$
  with since as (select now() - make_interval(days => greatest(least(coalesce(p_days, 365), 1095), 30)) t),
  pos as (
    select po.*, (select min(pi.posted_at) from purchase_invoices pi where pi.po_id = po.id and pi.status = 'posted') first_at
      from purchase_orders po where po.tenant_id = p_tenant and po.vendor_id = p_vendor and po.status not in ('cancelled', 'pending_approval')
       and po.created_at > (select t from since)),
  fill as (
    select sum(pol.base_qty) ordered, sum(least(po_line_received(pol.id), pol.base_qty)) got
      from purchase_order_lines pol join pos on pos.id = pol.po_id),
  bills as (
    select pi.* from purchase_invoices pi where pi.tenant_id = p_tenant and pi.vendor_id = p_vendor and pi.status = 'posted' and pi.kind <> 'opening'
       and pi.posted_at > (select t from since)),
  lines as (
    select pl.item_id, ib.unit_cost_base cost, ib.expiry_date, b.vendor_invoice_date bill_date, b.posted_at,
           row_number() over (partition by pl.item_id order by b.posted_at desc, b.purchase_no desc) rn
      from purchase_invoice_lines pl join bills b on b.id = pl.purchase_id join item_batches ib on ib.id = pl.batch_id),
  prices as (
    select l1.item_id, i.name, l1.cost last_cost, l2.cost prev_cost
      from lines l1 join lines l2 on l2.item_id = l1.item_id and l2.rn = 2 join inventory_items i on i.id = l1.item_id
     where l1.rn = 1 and l2.cost > 0 and l1.cost <> l2.cost)
  select jsonb_build_object(
    'orders', (select count(*) from pos),
    'fill_rate', (select case when ordered > 0 then round(got * 100 / ordered, 1) end from fill),
    'on_time_rate', (select case when count(*) > 0 then round(count(*) filter (where first_at::date <= expected_date) * 100.0 / count(*), 1) end
                       from pos where expected_date is not null and first_at is not null),
    'delivery_days', (select round(avg(extract(epoch from (first_at - created_at)) / 86400)::numeric, 1) from pos where first_at is not null),
    'bills', (select count(*) from bills),
    'purchased', (select coalesce(sum(total), 0) from bills),
    'returned', (select coalesce(sum(total), 0) from purchase_returns where tenant_id = p_tenant and vendor_id = p_vendor and posted_at > (select t from since)),
    'return_rate', (select case when coalesce(sum(b.total), 0) > 0 then round(coalesce((select sum(total) from purchase_returns where tenant_id = p_tenant and vendor_id = p_vendor and posted_at > (select t from since)), 0) * 100 / sum(b.total), 1) end from bills b),
    'shelf_life_days', (select round(avg(expiry_date - bill_date)) from lines where expiry_date is not null),
    'short_dated_lots', (select count(*) from lines where expiry_date is not null and expiry_date - bill_date < 180),
    'price_changes', coalesce((select jsonb_agg(jsonb_build_object('item', name, 'last', round(last_cost, 4), 'previous', round(prev_cost, 4),
                                                                   'change_pct', round((last_cost - prev_cost) * 100 / prev_cost, 1)) order by abs(last_cost - prev_cost) / prev_cost desc)
                                 from (select * from prices order by abs(last_cost - prev_cost) / prev_cost desc limit 10) p), '[]'));
$$;

-- Approve (open it) or reject (cancel it) an order waiting for approval. manage_settings,
-- and never the person who raised it.
create or replace function decide_purchase_order(p_tenant uuid, p_by uuid, p_po uuid, p_approve boolean, p_reason text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare po purchase_orders;
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_settings') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  select * into po from purchase_orders where id = p_po and tenant_id = p_tenant for update;
  if po.id is null then raise exception 'PO_NOT_FOUND' using errcode = 'P0001'; end if;
  if po.status <> 'pending_approval' then raise exception 'PO_NOT_PENDING' using errcode = 'P0001'; end if;
  if po.created_by = p_by then raise exception 'OWN_ORDER' using errcode = 'P0001'; end if;
  if not p_approve and length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  update purchase_orders set status = case when p_approve then 'open' else 'cancelled' end,
         approved_by = case when p_approve then p_by end, approved_at = case when p_approve then now() end,
         closed_reason = case when p_approve then null else 'Not approved: ' || btrim(p_reason) end
   where id = p_po;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, case when p_approve then 'po.approve' else 'po.reject' end, 'purchase_order', p_po::text, 'success',
          nullif(btrim(coalesce(p_reason, '')), ''), jsonb_build_object('no', po.po_no, 'total', po_expected_total(p_po)));
end $$;


-- ── orders: as in 0043, with the approval limit ───────────────────────────────
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
  -- M-46: above the clinic's limit (or with a line of unknown cost while a limit is set) it waits
  -- for someone who manages the settings, unless that is who raised it.
  if (select po_approval_limit from tenant_settings where tenant_id = p_tenant) is not null and not has_key(p_by, 'manage_settings')
     and (po_expected_total(v_id) > (select po_approval_limit from tenant_settings where tenant_id = p_tenant)
          or exists (select 1 from purchase_order_lines where po_id = v_id and expected_unit_cost is null)) then
    update purchase_orders set status = 'pending_approval' where id = v_id;
    perform notify_members(p_tenant, 'manage_settings', 'po_approval', 'Order to approve: ' || v_no,
      'Expected Rs. ' || to_char(po_expected_total(v_id), 'FM99,99,99,990.00') || '. Approve or reject it in Purchases → Orders.', '/admin/purchases/orders', 'purchase_order', v_id::text);
  end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, 'po.create', 'purchase_order', v_id::text, 'success', jsonb_build_object('no', v_no, 'vendor', p_vendor, 'lines', n));
  return v_id;
end $$;

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
    if po.status not in ('open', 'pending_approval') then raise exception 'PO_HAS_RECEIPTS' using errcode = 'P0001'; end if;
  elsif p_action = 'close' then
    if po.status not in ('open', 'partially_received') then raise exception 'PO_NOT_OPEN' using errcode = 'P0001'; end if;
  else raise exception 'BAD_ACTION' using errcode = 'P0001';
  end if;
  update purchase_orders set status = case when p_action = 'cancel' then 'cancelled' else 'closed' end, closed_reason = nullif(btrim(p_reason), '') where id = p_po;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, reason)
  values (p_tenant, 'member', p_by, 'po.' || p_action, 'purchase_order', p_po::text, 'success', nullif(btrim(p_reason), ''));
end $$;

-- ── vendors: as in 0041, with the delivery time ───────────────────────────────
create or replace function save_vendor(p_tenant uuid, p_vendor uuid, p_d jsonb, p_by uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := p_vendor; v_no bigint;
begin
  perform assert_active_member(p_tenant, p_by);
  if coalesce(length(btrim(p_d->>'name')), 0) < 2 then raise exception 'NAME_REQUIRED' using errcode = 'P0001'; end if;
  if v_id is null then
    insert into vendor_code_counters as c (tenant_id, next_no) values (p_tenant, 2)
    on conflict (tenant_id) do update set next_no = c.next_no + 1 returning next_no - 1 into v_no;
    insert into vendors (tenant_id, vendor_code, name) values (p_tenant, 'VEN-' || lpad(v_no::text, 4, '0'), btrim(p_d->>'name')) returning id into v_id;
  elsif not exists (select 1 from vendors where id = v_id and tenant_id = p_tenant) then
    raise exception 'VENDOR_NOT_FOUND' using errcode = 'P0001';
  end if;
  update vendors set name = btrim(p_d->>'name'), pan_vat_no = nullif(btrim(p_d->>'pan_vat_no'), ''), contact_person = nullif(btrim(p_d->>'contact_person'), ''),
         phone = nullif(btrim(p_d->>'phone'), ''), email = nullif(lower(btrim(p_d->>'email')), ''), address = nullif(btrim(p_d->>'address'), ''),
         payment_terms_days = nullif(p_d->>'payment_terms_days', '')::smallint, lead_time_days = nullif(p_d->>'lead_time_days', '')::smallint, is_active = coalesce((p_d->>'is_active')::boolean, true),
         notes = nullif(btrim(p_d->>'notes'), '')
   where id = v_id;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome)
  values (p_tenant, 'member', p_by, case when p_vendor is null then 'vendor.create' else 'vendor.update' end, 'vendor', v_id::text, 'success');
  return v_id;
exception when unique_violation then
  if sqlerrm like '%vendors_name%' then raise exception 'VENDOR_NAME_TAKEN' using errcode = 'P0001'; end if;
  raise;
end $$;


revoke all on function po_expected_total(uuid), vendor_lead_days(uuid, uuid), purchase_plan(uuid, uuid, integer), vendor_performance(uuid, uuid, integer),
                       decide_purchase_order(uuid, uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function po_expected_total(uuid), vendor_lead_days(uuid, uuid), purchase_plan(uuid, uuid, integer), vendor_performance(uuid, uuid, integer),
                          decide_purchase_order(uuid, uuid, uuid, boolean, text) to service_role;
-- create_purchase_order runs as ledger_writer: it needs the order total and notifications.
grant execute on function po_expected_total(uuid), notify_members(uuid, text, text, text, text, text, text, text) to ledger_writer;
grant select on tenant_settings to ledger_writer;
