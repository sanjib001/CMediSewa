-- 0021 B3 hardening: custom roles saved in one audited step; a credential whose council or
-- registration number changes loses its verification (D-30: verified means THIS number).

create or replace function credential_edit_unverifies()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.council is distinct from old.council or new.registration_no is distinct from old.registration_no then
    new.verified_at := null; new.verified_by_member_id := null; new.verified_by_platform_admin := null;
  end if;
  return new;
end $$;
create trigger member_credentials_unverify before update of council, registration_no on member_credentials
  for each row execute function credential_edit_unverifies();
revoke all on function credential_edit_unverifies() from public, anon, authenticated, service_role;

-- Create or update a clinic role (name, permissions, home screen). Permission keys are
-- validated by the tenant_roles_validate trigger; before/after go to the audit log.
create or replace function save_role(p_tenant uuid, p_role uuid, p_name text, p_description text,
                                     p_permissions text[], p_home_route text, p_by uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := p_role; v_before text[];
begin
  if not exists (select 1 from tenant_members where id = p_by and tenant_id = p_tenant and is_active) then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_id is null then
    insert into tenant_roles (tenant_id, name, description, permissions, home_route)
    values (p_tenant, btrim(p_name), nullif(btrim(p_description), ''), coalesce(p_permissions, '{}'), p_home_route)
    returning id into v_id;
  else
    select permissions into v_before from tenant_roles where id = v_id and tenant_id = p_tenant for update;
    if not found then raise exception 'ROLE_NOT_FOUND' using errcode = 'P0001'; end if;
    update tenant_roles set name = btrim(p_name), description = nullif(btrim(p_description), ''),
           permissions = coalesce(p_permissions, '{}'), home_route = p_home_route
     where id = v_id;
  end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, case when p_role is null then 'role.create' else 'role.update' end, 'tenant_role', v_id::text,
          'success', jsonb_build_object('before', v_before, 'after', p_permissions));
  return v_id;
end $$;
revoke all on function save_role(uuid, uuid, text, text, text[], text, uuid) from public, anon, authenticated;
grant execute on function save_role(uuid, uuid, text, text, text[], text, uuid) to service_role;
