-- CI only: make a plain Postgres container look like Supabase where our migrations care,
-- so the "replay every migration on an EMPTY database" check (roadmap B0) runs without the
-- full Supabase stack. Mirrors the roles/attributes observed on the dev project.
create role anon          nologin noinherit;
create role authenticated nologin noinherit;
create role service_role  nologin noinherit bypassrls;
create role supabase_admin nologin;
create schema if not exists extensions;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase ships pgcrypto in the extensions schema (staff PINs use crypt()/gen_salt()).
create extension if not exists pgcrypto with schema extensions;
-- Supabase Auth's users table: our tables reference auth.users(id); the DB tests insert
-- these columns. A minimal stand-in, NOT the real GoTrue schema.
create schema if not exists auth;
create table if not exists auth.users (
  id                  uuid primary key,
  instance_id         uuid,
  aud                 varchar(255),
  role                varchar(255),
  email               varchar(255),
  encrypted_password  varchar(255),
  email_confirmed_at  timestamptz,
  created_at          timestamptz,
  updated_at          timestamptz,
  is_sso_user         boolean not null default false,
  is_anonymous        boolean not null default false
);
-- Supabase's default: objects created by postgres grant anon/authenticated broad rights.
-- Reproduce the dangerous part so migration 0001/0006 are proven to remove it.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
