-- =============================================================================
-- 0065 STORE ACCESS FROM THE ROLE (simpler screens, D-149).
--  The clinic works with one pharmacy store (plus quarantine), and the "Who works in this
--  store" screen is gone. A member without an explicit store_members row now gets access
--  from their keys: manage_stock → manage; any key that sells, dispenses, receives, moves,
--  returns or disposes stock → operate; view_stock → view. An explicit row (set before)
--  still wins, and tenant admins and all_stores keep manage.
-- =============================================================================

create or replace function store_access(p_tenant uuid, p_member uuid, p_store uuid)
returns text
language sql
stable security definer
set search_path = pg_catalog, public
as $$
  select case
    when not exists (select 1 from stores where id = p_store and tenant_id = p_tenant) then null
    when not exists (select 1 from tenant_members where id = p_member and tenant_id = p_tenant and is_active) then null
    when exists (select 1 from tenant_members where id = p_member and tenant_id = p_tenant and is_active and membership_role = 'tenant_admin') then 'manage'
    when 'all_stores' = any (effective_permissions(p_member)) then 'manage'
    else coalesce(
      (select access from store_members where store_id = p_store and member_id = p_member and tenant_id = p_tenant),
      (select case
                when 'manage_stock' = any (k) then 'manage'
                when k && array['pharmacy_sell', 'dispense_prescription', 'receive_stock', 'transfer_stock', 'manage_purchases',
                                'return_to_vendor', 'dispose_stock', 'block_batches'] then 'operate'
                when 'view_stock' = any (k) then 'view'
              end
         from (select effective_permissions(p_member) k) e))
  end;
$$;
