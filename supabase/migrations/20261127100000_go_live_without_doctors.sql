-- =============================================================================
-- 0067 GO LIVE WITHOUT DOCTORS (owner, D-157).
--  A pharmacy-only (or not-yet-OPD) business must be able to go live and publish its website
--  without doctors, OPD schedules or a consultation service. Those stay on the setup list as
--  recommended steps; the website hides the OPD and booking parts while there are no doctors.
--  Still required: the clinic phone, the bill header (billing profile) and, with the pharmacy
--  counter module, an active pharmacy store.
-- =============================================================================

create or replace function public.go_live_blockers(p_tenant uuid)
 returns text[]
 language plpgsql
 stable
 set search_path to 'pg_catalog', 'public'
as $function$
declare v_mods text[] := effective_modules(p_tenant); v_out text[] := '{}'; v_t tenants;
begin
  select * into v_t from tenants where id = p_tenant;
  if coalesce(btrim(v_t.phone), '') = '' then v_out := array_append(v_out, 'clinic_phone'); end if;
  if not exists (select 1 from billing_profiles where tenant_id = p_tenant and is_default and is_active and coalesce(btrim(legal_name), '') <> '') then
    v_out := array_append(v_out, 'billing_profile');
  end if;
  if 'pharmacy_counter' = any (v_mods) and not exists (select 1 from stores where tenant_id = p_tenant and kind = 'pharmacy' and is_active) then
    v_out := array_append(v_out, 'pharmacy_store');
  end if;
  return v_out;
end $function$;
