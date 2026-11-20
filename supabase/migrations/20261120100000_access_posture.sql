-- =============================================================================
-- 0001 ACCESS POSTURE: set before any table exists (D-04, D-18)
--
-- The browser holds the publishable (anon) key, so `anon` and `authenticated` must hold
-- NOTHING in `public`. All data access is server-side as `service_role`, and RLS is
-- enabled on every table as a deny-all backstop.
--
-- Verified on the dev project (2026-11-20) before writing this:
--   * objects created by `postgres` default to granting anon/authenticated
--     TRUNCATE, REFERENCES, TRIGGER and MAINTAIN, and TRUNCATE bypasses RLS;
--   * the same defaults give `service_role` NO select/insert/update/delete, so without
--     explicit grants the app could not read its own tables (HRestroSewa hit exactly this
--     on its self-hosted move: "permission denied for table finance_openings");
--   * `postgres` is not a member of `supabase_admin` on hosted Supabase, so that role's
--     defaults can only be changed where membership exists (guarded below).
--
-- Functions: Postgres grants EXECUTE to PUBLIC by default. Here NO role gets EXECUTE by
-- default, including service_role. Every RPC grants itself explicitly in its own migration,
-- so an internal helper can never become callable by accident.
-- =============================================================================

do $$
declare
  grantor text;
begin
  foreach grantor in array array[current_user::text, 'supabase_admin'] loop
    if grantor = current_user or pg_has_role(current_user, grantor, 'member') then
      execute format('alter default privileges for role %I in schema public revoke all on tables    from anon, authenticated, public', grantor);
      execute format('alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated, public', grantor);
      execute format('alter default privileges for role %I in schema public revoke all on functions from anon, authenticated, public, service_role', grantor);
      execute format('alter default privileges for role %I in schema public revoke all on types     from anon, authenticated, public', grantor);
      -- service_role: plain DML on future tables; every migration then narrows this where
      -- a table must be append-only or ledger-only.
      execute format('alter default privileges for role %I in schema public grant select, insert, update, delete on tables to service_role', grantor);
      execute format('alter default privileges for role %I in schema public grant usage, select on sequences to service_role', grantor);
    end if;
  end loop;
end $$;

-- Nothing exists yet, but a re-run on a database that already has objects must converge.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;

comment on schema public is
  'CMediSewa application schema. anon/authenticated hold no privileges here (migration 0001); access is server-side as service_role, RLS on every table as a backstop.';
