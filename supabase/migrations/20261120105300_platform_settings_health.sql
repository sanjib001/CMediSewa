-- =============================================================================
-- 0054 PLATFORM SETTINGS & HEALTH (U2): one row of platform settings (support contact shown on
-- the public Contact page, whether new clinic registrations are open), changed only by a
-- platform admin and audited; and a health summary for the Super Admin overview built from
-- what the nightly checks and the notification dispatcher already record.
-- Decisions D-131, D-132.
-- =============================================================================

create table platform_settings (
  id                  boolean primary key default true check (id),
  support_phone       text check (support_phone ~ '^[0-9+() -]{7,20}$'),
  support_email       text check (support_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  support_whatsapp    text check (support_whatsapp ~ '^[0-9+() -]{7,20}$'),
  support_hours       text check (length(support_hours) <= 120),
  office_address      text check (length(office_address) <= 200),
  registrations_open  boolean not null default true,
  updated_by          uuid references platform_admins (id),
  updated_at          timestamptz not null default now()
);
insert into platform_settings (id) values (true);
alter table platform_settings enable row level security;
revoke insert, update, delete on platform_settings from service_role;

create or replace function set_platform_settings(p_by uuid, p_s jsonb)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_before jsonb;
begin
  if not exists (select 1 from platform_admins where id = p_by and is_active) then raise exception 'NOT_PLATFORM_ADMIN' using errcode = 'P0001'; end if;
  select to_jsonb(s) - 'updated_at' - 'updated_by' - 'id' into v_before from platform_settings s;
  update platform_settings set
    support_phone = nullif(btrim(p_s->>'support_phone'), ''), support_email = lower(nullif(btrim(p_s->>'support_email'), '')),
    support_whatsapp = nullif(btrim(p_s->>'support_whatsapp'), ''), support_hours = nullif(btrim(p_s->>'support_hours'), ''),
    office_address = nullif(btrim(p_s->>'office_address'), ''), registrations_open = coalesce((p_s->>'registrations_open')::boolean, true),
    updated_by = p_by, updated_at = now()
  where id;   -- the API refuses an UPDATE without WHERE (Supabase safeupdate)
  insert into audit_log (actor_kind, actor_id, action, target_type, outcome, detail)
  values ('platform_admin', p_by, 'platform.settings', 'platform', 'success',
          jsonb_build_object('before', v_before, 'after', (select to_jsonb(s) - 'updated_at' - 'updated_by' - 'id' from platform_settings s)));
end $$;

-- What the Super Admin needs to see at a glance (no patient data, counts and clinic names only).
create or replace function platform_health()
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'last_nightly', (select max(ran_at) from finance_checks),
    'finance_mismatch', coalesce((select jsonb_agg(jsonb_build_object('tenant', t.name, 'slug', t.slug, 'mismatches', f.mismatches, 'at', f.ran_at) order by t.name)
        from (select distinct on (tenant_id) tenant_id, mismatches, ran_at from finance_checks order by tenant_id, ran_at desc) f join tenants t on t.id = f.tenant_id
       where f.mismatches > 0 and t.status in ('active', 'pending')), '[]'),
    'stock_repaired_7d', (select coalesce(sum(mismatches), 0) from stock_reconciliations where ran_at > now() - interval '7 days'),
    'payable_mismatch', coalesce((select jsonb_agg(jsonb_build_object('tenant', t.name, 'slug', t.slug, 'mismatches', p.mismatches) order by t.name)
        from (select distinct on (tenant_id) tenant_id, mismatches from payable_reconciliations order by tenant_id, ran_at desc) p join tenants t on t.id = p.tenant_id
       where p.mismatches > 0 and t.status in ('active', 'pending')), '[]'),
    'errors_24h', (select count(*) from audit_log where outcome = 'error' and created_at > now() - interval '24 hours'),
    'denied_24h', (select count(*) from audit_log where outcome = 'denied' and created_at > now() - interval '24 hours'),
    'outbox_waiting', (select count(*) from notification_outbox o join tenants t on t.id = o.tenant_id
                        where o.status in ('pending', 'sending') and o.next_attempt_at < now() - interval '30 minutes' and t.status in ('active', 'pending')),
    'outbox_failed_7d', (select count(*) from notification_outbox where status = 'failed' and created_at > now() - interval '7 days'),
    'outbox_dry_run_7d', (select count(*) from notification_outbox where status = 'skipped' and last_error like '%dry run%' and created_at > now() - interval '7 days'),
    'outbox_sent_7d', (select count(*) from notification_outbox where status = 'sent' and created_at > now() - interval '7 days'),
    'expiring_14d', coalesce((select jsonb_agg(jsonb_build_object('tenant', t.name, 'slug', t.slug, 'until', tenant_paid_until(t.id)) order by tenant_paid_until(t.id))
        from tenants t where t.status = 'active' and tenant_paid_until(t.id) between current_date and current_date + 14), '[]'));
$$;

revoke all on function set_platform_settings(uuid, jsonb), platform_health() from public, anon, authenticated;
grant execute on function set_platform_settings(uuid, jsonb), platform_health() to service_role;
