-- 0019 Fix go_live_blockers: `text[] || 'literal'` is parsed as array || array-literal
-- ("malformed array literal"), caught by tests/db/setup.test.mjs before any use.
-- Same behaviour, using array_append.
create or replace function go_live_blockers(p_tenant uuid)
returns text[]
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_mods text[] := effective_modules(p_tenant); v_out text[] := '{}'; v_t tenants;
begin
  select * into v_t from tenants where id = p_tenant;
  if coalesce(btrim(v_t.phone), '') = '' then v_out := array_append(v_out, 'clinic_phone'); end if;
  if not exists (select 1 from billing_profiles where tenant_id = p_tenant and is_default and is_active and coalesce(btrim(legal_name), '') <> '') then
    v_out := array_append(v_out, 'billing_profile');
  end if;
  if 'appointments' = any (v_mods) then
    if not exists (select 1 from services where tenant_id = p_tenant and is_active and kind = 'consultation') then
      v_out := array_append(v_out, 'consultation_service');
    end if;
    if not exists (select 1 from doctor_profiles dp join tenant_members m on m.id = dp.member_id and m.is_active
                    join doctor_schedules s on s.member_id = dp.member_id where dp.tenant_id = p_tenant) then
      v_out := array_append(v_out, 'doctor_with_schedule');
    end if;
  end if;
  if 'pharmacy_counter' = any (v_mods) and not exists (select 1 from stores where tenant_id = p_tenant and kind = 'pharmacy' and is_active) then
    v_out := array_append(v_out, 'pharmacy_store');
  end if;
  return v_out;
end $$;
