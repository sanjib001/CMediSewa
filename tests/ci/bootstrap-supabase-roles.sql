-- CI only: make a plain Postgres container look like Supabase where our migrations care,
-- so the "replay every migration on an EMPTY database" check (roadmap B0) runs without the
-- full Supabase stack. Mirrors the roles/attributes observed on the dev project.
create role anon          nologin noinherit;
create role authenticated nologin noinherit;
create role service_role  nologin noinherit bypassrls;
create role supabase_admin nologin;
create schema if not exists extensions;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default: objects created by postgres grant anon/authenticated broad rights.
-- Reproduce the dangerous part so migration 0001/0006 are proven to remove it.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
