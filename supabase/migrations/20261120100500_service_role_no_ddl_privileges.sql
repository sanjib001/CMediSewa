-- =============================================================================
-- 0006 service_role keeps DML only: no TRUNCATE / TRIGGER / REFERENCES / MAINTAIN
--
-- Found by the posture check on its first run (2026-11-20): the `postgres` default ACL
-- also grants service_role `Dxtm` on every new table, and migration 0001 only adjusted
-- select/insert/update/delete. TRUNCATE skips row triggers and RLS; the app never needs it,
-- nor trigger/references/maintain. forbid_mutation already blocks TRUNCATE on append-only
-- tables. This removes the privilege everywhere. Fixed forward, not by editing 0001.
-- =============================================================================

do $$
declare
  grantor text;
  extra   text := case when current_setting('server_version_num')::int >= 170000 then ', maintain' else '' end;
begin
  execute format('revoke truncate, trigger, references%s on all tables in schema public from service_role', extra);
  foreach grantor in array array[current_user::text, 'supabase_admin'] loop
    if grantor = current_user or pg_has_role(current_user, grantor, 'member') then
      execute format('alter default privileges for role %I in schema public revoke truncate, trigger, references%s on tables from service_role', grantor, extra);
    end if;
  end loop;
end $$;
