-- 0042 Super Admin creates a clinic directly (user request; HRestroSewa's "New restaurant").
-- No separate code path: the details are recorded as a DIRECT application (source = 'direct')
-- and provisioned by the same provision_tenant(), in ONE transaction. The clinic's admin
-- account is created with a one-time setup link (7 days); the Super Admin shares it, the admin
-- sets a password and 2FA, then signs in at /login/<clinic> and adds staff.

alter table tenant_applications add column source text not null default 'website' check (source in ('website', 'direct'));
comment on column tenant_applications.source is 'website = sent from the marketing page and reviewed; direct = entered by a platform admin who created the clinic at once.';

create or replace function create_tenant_direct(
  p_business_name text, p_slug text, p_owner_name text, p_owner_email text, p_phone text, p_district text, p_municipality text, p_pan text,
  p_plan uuid, p_starts_on date, p_period_days integer, p_source text, p_invite_token_hash text, p_by uuid
) returns table (tenant_id uuid, member_id uuid)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_variable
declare v_app uuid;
begin
  if not exists (select 1 from platform_admins where id = p_by and is_active) then raise exception 'NOT_PLATFORM_ADMIN' using errcode = 'P0001'; end if;
  if p_pan is not null and btrim(p_pan) <> '' and btrim(p_pan) !~ '^\d{9}$' then raise exception 'BAD_PAN' using errcode = 'P0001'; end if;
  -- An admin email already running another clinic would collide at sign-up; say so now.
  if exists (select 1 from tenant_members m join tenants t on t.id = m.tenant_id
              where lower(m.email) = lower(btrim(p_owner_email)) and m.membership_role = 'tenant_admin' and m.is_active and t.status <> 'closed') then
    raise exception 'ADMIN_EMAIL_IN_USE' using errcode = 'P0001';
  end if;
  insert into tenant_applications (business_name, owner_name, email, phone, district, municipality, pan_number, plan_interest, source)
  values (btrim(p_business_name), btrim(p_owner_name), lower(btrim(p_owner_email)), btrim(p_phone), nullif(btrim(p_district), ''),
          nullif(btrim(p_municipality), ''), nullif(btrim(p_pan), ''), p_plan, 'direct')
  returning id into v_app;
  return query select pt.tenant_id, pt.member_id
    from provision_tenant(v_app, p_slug, p_plan, p_starts_on, p_period_days, p_source, p_invite_token_hash, p_by) pt;
end $$;
revoke all on function create_tenant_direct(text, text, text, text, text, text, text, text, uuid, date, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function create_tenant_direct(text, text, text, text, text, text, text, text, uuid, date, integer, text, text, uuid) to service_role;
