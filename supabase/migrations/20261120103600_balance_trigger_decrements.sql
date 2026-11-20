-- 0037 Found by tests/db/stock-ops.test.mjs: EVERY stock decrease failed. apply_stock_movement used
-- INSERT … ON CONFLICT DO UPDATE, and Postgres checks CHECK constraints on the PROPOSED row (a
-- negative qty_on_hand) before resolving the conflict. Decreases now UPDATE the existing
-- balance; a missing or too-small balance still fails the non-negative rule.
create or replace function apply_stock_movement()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.qty_base > 0 then
    insert into stock_balances as b (tenant_id, store_id, batch_id, item_id, qty_on_hand)
    values (new.tenant_id, new.store_id, new.batch_id, new.item_id, new.qty_base)
    on conflict (tenant_id, store_id, batch_id)
    do update set qty_on_hand = b.qty_on_hand + excluded.qty_on_hand, updated_at = now();
  else
    update stock_balances set qty_on_hand = qty_on_hand + new.qty_base, updated_at = now()
     where tenant_id = new.tenant_id and store_id = new.store_id and batch_id = new.batch_id;
    if not found then
      raise exception 'new row for relation "stock_balances" violates check constraint "stock_balances_qty_on_hand_check"' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
