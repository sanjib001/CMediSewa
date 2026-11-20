-- 0036 Found by tests/db/stock-ops.test.mjs before any use: has_key() ran with the CALLER's
-- rights, and the stock functions run as ledger_writer, which can't read the permission
-- tables. Like store_access(), it now runs with its owner's rights.
create or replace function has_key(p_member uuid, p_key text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$ select p_key = any (effective_permissions(p_member)); $$;
revoke all on function has_key(uuid, text) from public, anon, authenticated, service_role;
grant execute on function has_key(uuid, text) to ledger_writer;
