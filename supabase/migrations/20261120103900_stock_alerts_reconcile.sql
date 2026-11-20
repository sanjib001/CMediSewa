-- =============================================================================
-- 0040 STOCK ALERTS, PURCHASE SUGGESTIONS, RECONCILIATION (B5c). database.md §8.1, §9.2.
-- Alerts and suggestions are computed on demand (no stored state to drift). Reconciliation
-- compares every balance with Σ stock_movements, repairs any difference from the ledger and
-- writes an audit row; it runs nightly from the job route and can be run from the Admin.
-- =============================================================================

-- Levels that apply to an item in a store: the store's override, else the item's own.
create or replace function item_levels(p_tenant uuid, p_store uuid, p_item uuid,
  out min_level numeric, out reorder_level numeric, out max_level numeric, out reorder_qty numeric)
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce(sl.min_stock_level, i.min_stock_level), coalesce(sl.reorder_level, i.reorder_level),
         coalesce(sl.max_stock_level, i.max_stock_level), i.reorder_qty
    from inventory_items i left join store_item_levels sl on sl.item_id = i.id and sl.store_id = p_store
   where i.id = p_item and i.tenant_id = p_tenant;
$$;

-- Everything a pharmacist should look at, newest problems first:
--   expired     lot on hand past its expiry (any store except quarantine)
--   blocked     blocked/recalled lot still on hand outside quarantine
--   near_expiry lot within the near-expiry window (critical when inside the critical window)
--   critical    sellable stock at or below the minimum level
--   low         sellable stock at or below the reorder level
create or replace function stock_alerts(p_tenant uuid, p_store uuid default null)
returns table (kind text, severity text, store_id uuid, item_id uuid, batch_id uuid, batch_no text, expiry_date date, qty_base numeric, level numeric, days_left integer)
language sql stable
set search_path = pg_catalog, public
as $$
  with s as (select near_expiry_days, critical_expiry_days, min_sale_shelf_days from tenant_settings where tenant_id = p_tenant),
  today as (select (now() at time zone timezone)::date d from tenants where id = p_tenant),
  lots as (
    select b.store_id, b.item_id, b.batch_id, ib.batch_no, ib.expiry_date, ib.status, b.qty_on_hand
      from stock_balances b join item_batches ib on ib.id = b.batch_id join stores st on st.id = b.store_id
     where b.tenant_id = p_tenant and b.qty_on_hand > 0 and st.kind <> 'quarantine' and st.is_active
       and (p_store is null or b.store_id = p_store)),
  sellable as (
    select l.store_id, l.item_id, sum(l.qty_on_hand) q
      from lots l, today, s
     where l.status = 'active' and (l.expiry_date is null or l.expiry_date > today.d + s.min_sale_shelf_days)
     group by 1, 2),
  stocked as (   -- every (store, item) that has ever had stock there, so zero stock still alerts
    select distinct m.store_id, m.item_id from stock_movements m join stores st on st.id = m.store_id
     where m.tenant_id = p_tenant and st.kind <> 'quarantine' and st.is_active and (p_store is null or m.store_id = p_store))
  select 'expired', 'critical', l.store_id, l.item_id, l.batch_id, l.batch_no, l.expiry_date, l.qty_on_hand, null::numeric, (l.expiry_date - today.d)
    from lots l, today where l.expiry_date is not null and l.expiry_date <= today.d
  union all
  select 'blocked', 'critical', l.store_id, l.item_id, l.batch_id, l.batch_no, l.expiry_date, l.qty_on_hand, null, null
    from lots l where l.status <> 'active'
  union all
  select 'near_expiry', case when l.expiry_date <= today.d + s.critical_expiry_days then 'critical' else 'warning' end,
         l.store_id, l.item_id, l.batch_id, l.batch_no, l.expiry_date, l.qty_on_hand, null, (l.expiry_date - today.d)
    from lots l, today, s where l.status = 'active' and l.expiry_date > today.d and l.expiry_date <= today.d + s.near_expiry_days
  union all
  select case when coalesce(sb.q, 0) <= lv.min_level then 'critical_stock' else 'low_stock' end,
         case when coalesce(sb.q, 0) <= lv.min_level then 'critical' else 'warning' end,
         k.store_id, k.item_id, null, null, null, coalesce(sb.q, 0),
         case when coalesce(sb.q, 0) <= lv.min_level then lv.min_level else lv.reorder_level end, null
    from stocked k
    join inventory_items i on i.id = k.item_id and i.is_active and i.deleted_at is null
    cross join lateral item_levels(p_tenant, k.store_id, k.item_id) lv
    left join sellable sb on sb.store_id = k.store_id and sb.item_id = k.item_id
   where (lv.min_level is not null and coalesce(sb.q, 0) <= lv.min_level)
      or (lv.reorder_level is not null and coalesce(sb.q, 0) <= lv.reorder_level);
$$;

-- What to buy (feeds purchase orders in B6): for each item at or below its reorder level in a
-- RECEIVING store, order up to the maximum (or the reorder quantity, or twice the reorder
-- level), in base units and in the usual purchase unit, priced at the last lot cost.
create or replace function purchase_suggestions(p_tenant uuid, p_store uuid default null)
returns table (store_id uuid, item_id uuid, on_hand numeric, reorder_level numeric, suggested_base numeric,
               purchase_unit_id uuid, purchase_unit text, suggested_units numeric, last_unit_cost_base numeric, est_cost numeric)
language sql stable
set search_path = pg_catalog, public
as $$
  with a as (
    select al.store_id, al.item_id, al.qty_base on_hand
      from stock_alerts(p_tenant, p_store) al join stores st on st.id = al.store_id and st.is_receiving
     where al.kind in ('low_stock', 'critical_stock')),
  calc as (
    select a.*, lv.reorder_level rl,
           greatest(coalesce(lv.max_level - a.on_hand, lv.reorder_qty, lv.reorder_level * 2 - a.on_hand, 0), lv.reorder_qty, 0) need
      from a cross join lateral item_levels(p_tenant, a.store_id, a.item_id) lv),
  unit as (
    select c.*, coalesce(u_def.id, u_big.id) uid, coalesce(u_def.name, u_big.name) uname, coalesce(u_def.factor_to_base, u_big.factor_to_base, 1) f,
           (select ib.unit_cost_base from item_batches ib where ib.item_id = c.item_id order by ib.created_at desc limit 1) cost
      from calc c
      join inventory_items i on i.id = c.item_id
      left join item_units u_def on u_def.id = i.default_purchase_unit_id
      left join lateral (select id, name, factor_to_base from item_units where item_id = c.item_id and can_purchase order by factor_to_base desc limit 1) u_big on true)
  select store_id, item_id, on_hand, rl, need, uid, uname,
         ceil(need / nullif(f, 0)), cost, round(ceil(need / nullif(f, 0)) * f * coalesce(cost, 0), 2)
    from unit where need > 0;
$$;

-- Reconciliation: balance = Σ ledger, always. Repairs any difference from the ledger.
create table stock_reconciliations (
  id            bigserial primary key,
  tenant_id     uuid not null references tenants (id) on delete restrict,
  ran_at        timestamptz not null default now(),
  checked       integer not null,
  mismatches    integer not null,
  details       jsonb,
  triggered_by  uuid,
  foreign key (tenant_id, triggered_by) references tenant_members (tenant_id, id)
);
alter table stock_reconciliations enable row level security;
revoke insert, update, delete on stock_reconciliations from service_role;
revoke usage on sequence stock_reconciliations_id_seq from service_role;

create or replace function reconcile_stock_balances(p_tenant uuid, p_by uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_checked integer; v_bad jsonb; v_n integer;
begin
  with ledger as (
    select store_id, batch_id, item_id, sum(qty_base) q from stock_movements where tenant_id = p_tenant group by 1, 2, 3),
  cmp as (
    select coalesce(l.store_id, b.store_id) store_id, coalesce(l.batch_id, b.batch_id) batch_id, coalesce(l.item_id, b.item_id) item_id,
           coalesce(l.q, 0) ledger_q, coalesce(b.qty_on_hand, 0) balance_q
      from ledger l full join (select * from stock_balances where tenant_id = p_tenant) b on b.store_id = l.store_id and b.batch_id = l.batch_id)
  select count(*), coalesce(jsonb_agg(jsonb_build_object('store_id', store_id, 'batch_id', batch_id, 'item_id', item_id, 'ledger', ledger_q, 'balance', balance_q))
                       filter (where ledger_q <> balance_q), '[]')
    into v_checked, v_bad from cmp;
  v_n := jsonb_array_length(v_bad);
  if v_n > 0 then
    -- Repair from the ledger (the source of truth).
    insert into stock_balances as b (tenant_id, store_id, batch_id, item_id, qty_on_hand)
    select p_tenant, (x->>'store_id')::uuid, (x->>'batch_id')::uuid, (x->>'item_id')::uuid, (x->>'ledger')::numeric
      from jsonb_array_elements(v_bad) x
    on conflict (tenant_id, store_id, batch_id) do update set qty_on_hand = excluded.qty_on_hand, updated_at = now();
  end if;
  insert into stock_reconciliations (tenant_id, checked, mismatches, details, triggered_by) values (p_tenant, v_checked, v_n, nullif(v_bad, '[]'::jsonb), p_by);
  if v_n > 0 then
    insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, outcome, reason, detail)
    values (p_tenant, case when p_by is null then 'system' else 'member' end, p_by, 'stock.reconcile', 'tenant', 'error', 'balance_mismatch_repaired', jsonb_build_object('mismatches', v_bad));
  end if;
  return jsonb_build_object('checked', v_checked, 'mismatches', v_n);
end $$;

-- Nightly job: every live clinic.
create or replace function reconcile_all_tenants()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare t uuid; r jsonb; v_out jsonb := '[]'; v_total integer := 0;
begin
  for t in select id from tenants where status in ('active', 'pending') loop
    r := reconcile_stock_balances(t, null);
    v_total := v_total + (r->>'mismatches')::integer;
    if (r->>'mismatches')::integer > 0 then v_out := v_out || jsonb_build_object('tenant', t, 'mismatches', r->'mismatches'); end if;
  end loop;
  return jsonb_build_object('mismatches', v_total, 'tenants', v_out);
end $$;

grant select on stock_movements, stock_balances, tenants to ledger_writer;
grant insert on stock_reconciliations to ledger_writer;
grant usage, select on sequence stock_reconciliations_id_seq to ledger_writer;
grant create on schema public to ledger_writer;
alter function reconcile_stock_balances(uuid, uuid) owner to ledger_writer;
alter function reconcile_all_tenants() owner to ledger_writer;
revoke create on schema public from ledger_writer;

revoke all on function item_levels(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function stock_alerts(uuid, uuid) from public, anon, authenticated;
revoke all on function purchase_suggestions(uuid, uuid) from public, anon, authenticated;
revoke all on function reconcile_stock_balances(uuid, uuid) from public, anon, authenticated;
revoke all on function reconcile_all_tenants() from public, anon, authenticated;
grant execute on function item_levels(uuid, uuid, uuid) to service_role;
grant execute on function stock_alerts(uuid, uuid) to service_role;
grant execute on function purchase_suggestions(uuid, uuid) to service_role;
grant execute on function reconcile_stock_balances(uuid, uuid) to service_role;
grant execute on function reconcile_all_tenants() to service_role;
