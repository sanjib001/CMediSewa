-- 0038 write_movement mapped only the qty_on_hand CHECK to INSUFFICIENT_STOCK; an over-draw can
-- trip stock_balances' other CHECK (reserved <= on hand) first. Any stock_balances CHECK = short.
create or replace function write_movement(p_tenant uuid, p_store uuid, p_batch uuid, p_item uuid, p_qty numeric, p_kind text, p_cost numeric,
                                          p_posting uuid, p_doc_type text, p_doc uuid, p_line uuid, p_reason text, p_by uuid)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into stock_movements (tenant_id, store_id, batch_id, item_id, qty_base, kind, unit_cost_base, posting_id, doc_type, doc_id, doc_line_id, reason_code, created_by)
  values (p_tenant, p_store, p_batch, p_item, p_qty, p_kind, p_cost, p_posting, p_doc_type, p_doc, p_line, p_reason, p_by);
exception when check_violation then
  if sqlerrm like '%stock_balances%' then raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0001'; end if;
  raise;
end $$;
