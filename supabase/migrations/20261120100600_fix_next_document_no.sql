-- =============================================================================
-- 0007 Fix next_document_no: OUT column `fiscal_year` clashed with the table column in
-- ON CONFLICT (42702 "column reference is ambiguous"). Caught by
-- tests/db/posting-core.test.mjs on its first run, before anything used the function.
-- Same signature and behaviour; the conflict target is now the named primary key.
-- Ownership (ledger_writer) and privileges are preserved by CREATE OR REPLACE.
-- =============================================================================

create or replace function next_document_no(
  p_tenant uuid, p_doc_type text, p_scope uuid, p_at timestamptz default now()
) returns table (fiscal_year text, doc_no bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_variable
declare
  v_tz text; v_fy text; v_no bigint;
begin
  select t.timezone into v_tz from tenants t where t.id = p_tenant;
  if v_tz is null then raise exception 'TENANT_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_scope <> p_tenant and not exists (
       select 1 from billing_profiles b where b.tenant_id = p_tenant and b.id = p_scope) then
    raise exception 'SCOPE_NOT_IN_TENANT' using errcode = 'P0001';
  end if;
  v_fy := fiscal_year_of(p_at, v_tz);
  insert into document_sequences as s (tenant_id, doc_type, scope_id, fiscal_year, next_no)
  values (p_tenant, p_doc_type, p_scope, v_fy, 2)
  on conflict on constraint document_sequences_pkey
    do update set next_no = s.next_no + 1
  returning s.next_no - 1 into v_no;
  return query select v_fy, v_no;
end;
$$;
