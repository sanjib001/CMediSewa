-- 0039 Found by the B5b end-to-end test: provisioning creates the Quarantine store with
-- is_receiving = false (it never receives purchases or opening stock), so request_transfer
-- refused every move INTO quarantine. Transfers may always go to a quarantine store; opening
-- stock and purchases still require a receiving store.
create or replace function request_transfer(p_tenant uuid, p_by uuid, p_from uuid, p_to uuid, p_items jsonb, p_note text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_fy text; v_no text; i jsonb; v_unit item_units; v_need_approval boolean;
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'transfer_stock') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_from), 'view') = 'view' and coalesce(store_access(p_tenant, p_by, p_to), 'view') = 'view' then
    raise exception 'NO_STORE_ACCESS' using errcode = 'P0001';
  end if;
  if not exists (select 1 from stores where id = p_to and tenant_id = p_tenant and is_active and (is_receiving or kind = 'quarantine')) then raise exception 'STORE_NOT_RECEIVING' using errcode = 'P0001'; end if;
  if not exists (select 1 from stores where id = p_from and tenant_id = p_tenant and is_active) then raise exception 'STORE_NOT_FOUND' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select transfer_approval_required into v_need_approval from tenant_settings where tenant_id = p_tenant;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'transfer', 'TR') d;
  insert into stock_transfers (id, tenant_id, transfer_no, fiscal_year, from_store_id, to_store_id, status, note, requested_by, decided_by, decided_at)
  values (v_id, p_tenant, v_no, v_fy, p_from, p_to, case when v_need_approval then 'requested' else 'approved' end, nullif(btrim(p_note), ''), p_by,
          case when v_need_approval then null else p_by end, case when v_need_approval then null else now() end);
  for i in select * from jsonb_array_elements(p_items) loop
    select u.* into v_unit from item_units u join inventory_items it on it.id = u.item_id and it.tenant_id = p_tenant
     where u.id = (i->>'unit_id')::uuid and u.item_id = (i->>'item_id')::uuid;
    if v_unit.id is null then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0001'; end if;
    if coalesce((i->>'qty')::numeric, 0) <= 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
    insert into stock_transfer_items (tenant_id, transfer_id, item_id, unit_id, requested_qty, factor_snapshot, batch_id)
    values (p_tenant, v_id, v_unit.item_id, v_unit.id, (i->>'qty')::numeric, v_unit.factor_to_base, nullif(i->>'batch_id', '')::uuid);
  end loop;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, 'transfer.request', 'stock_transfer', v_id::text, 'success', jsonb_build_object('no', v_no, 'from', p_from, 'to', p_to));
  return v_id;
end $$;
