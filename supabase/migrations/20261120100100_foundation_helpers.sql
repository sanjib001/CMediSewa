-- =============================================================================
-- 0002 FOUNDATION HELPERS: extensions and shared trigger functions
-- =============================================================================

-- btree_gist: exclusion constraints that prevent double booking (D-11, B4).
-- pg_trgm: fuzzy patient/item name search (B4/B5).
-- Installed in the Supabase-standard `extensions` schema, not in `public`.
create extension if not exists btree_gist with schema extensions;
create extension if not exists pg_trgm    with schema extensions;

-- Keeps updated_at honest without trusting application code to set it.
create or replace function touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
comment on function touch_updated_at() is 'BEFORE UPDATE trigger: stamps updated_at = now().';

-- Append-only enforcement. Used on audit_log, postings, ledger_entries (and stock_movements
-- in B5). Raised as a bare code so actions can map it (architecture.md §4).
create or replace function forbid_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'APPEND_ONLY: % on % is not allowed', tg_op, tg_table_name
    using errcode = 'P0001';
end;
$$;
comment on function forbid_mutation() is
  'Trigger: rejects UPDATE/DELETE/TRUNCATE on append-only tables. Corrections are new rows (reversal postings), never edits.';

revoke all on function touch_updated_at() from public, anon, authenticated, service_role;
revoke all on function forbid_mutation()  from public, anon, authenticated, service_role;
