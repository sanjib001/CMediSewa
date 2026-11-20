-- 0012 Fix verify_pin: its OUT column `device_id` clashed with pin_attempts.device_id
-- (42702 "column reference is ambiguous"), caught by tests/db/identity.test.mjs before any use.
-- Same signature and behaviour; `#variable_conflict use_column` makes bare names mean columns
-- (every variable in the body is v_-prefixed). Privileges are preserved by CREATE OR REPLACE.
create or replace function verify_pin(p_tenant uuid, p_member uuid, p_pin text, p_device_token_hash text, p_ip inet default null)
returns table (ok boolean, reason text, retry_after timestamptz, auth_user_id uuid, device_id uuid)
language plpgsql security definer
set search_path = pg_catalog, public, extensions
as $$
#variable_conflict use_column
declare
  v_dev trusted_devices; v_mem tenant_members; v_pin member_pins; v_fail int; v_policy text; v_status tenant_status;
begin
  select * into v_dev from trusted_devices
   where token_hash = p_device_token_hash and tenant_id = p_tenant and revoked_at is null;
  if v_dev.id is null then
    return query select false, 'DEVICE_NOT_TRUSTED', null::timestamptz, null::uuid, null::uuid; return;
  end if;

  select count(*) into v_fail from pin_attempts
   where device_id = v_dev.id and not success and at > now() - interval '1 hour';
  if v_fail >= 20 then
    return query select false, 'DEVICE_THROTTLED', now() + interval '1 hour', null::uuid, v_dev.id; return;
  end if;

  select t.status, s.pin_policy into v_status, v_policy
    from tenants t left join tenant_settings s on s.tenant_id = t.id where t.id = p_tenant;
  select * into v_mem from tenant_members
   where id = p_member and tenant_id = p_tenant and is_active and deleted_at is null and auth_user_id is not null;
  if v_mem.id is null or v_status <> 'active' or coalesce(v_policy, 'allowed') = 'off'
     or (v_dev.allowed_member_ids is not null and not (p_member = any (v_dev.allowed_member_ids))) then
    insert into pin_attempts (tenant_id, member_id, device_id, ip, success, reason) values (p_tenant, p_member, v_dev.id, p_ip, false, 'NOT_ALLOWED');
    return query select false, 'NOT_ALLOWED', null::timestamptz, null::uuid, v_dev.id; return;
  end if;

  select * into v_pin from member_pins where member_id = p_member for update;
  if v_pin.member_id is null or v_pin.must_change then
    return query select false, 'PIN_NOT_SET', null::timestamptz, null::uuid, v_dev.id; return;
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    -- A locked PIN refuses even the RIGHT digits (HRestroSewa's lockout rule).
    insert into pin_attempts (tenant_id, member_id, device_id, ip, success, reason) values (p_tenant, p_member, v_dev.id, p_ip, false, 'PIN_LOCKED');
    return query select false, 'PIN_LOCKED', v_pin.locked_until, null::uuid, v_dev.id; return;
  end if;

  if crypt(p_pin, v_pin.pin_hash) <> v_pin.pin_hash then
    if v_pin.failed_count + 1 >= 5 then
      update member_pins set failed_count = 0, locked_until = now() + interval '15 minutes' where member_id = p_member;
      insert into pin_attempts (tenant_id, member_id, device_id, ip, success, reason) values (p_tenant, p_member, v_dev.id, p_ip, false, 'PIN_LOCKED');
      return query select false, 'PIN_LOCKED', now() + interval '15 minutes', null::uuid, v_dev.id; return;
    end if;
    update member_pins set failed_count = failed_count + 1 where member_id = p_member;
    insert into pin_attempts (tenant_id, member_id, device_id, ip, success, reason) values (p_tenant, p_member, v_dev.id, p_ip, false, 'BAD_PIN');
    return query select false, 'BAD_PIN', null::timestamptz, null::uuid, v_dev.id; return;
  end if;

  update member_pins set failed_count = 0, locked_until = null where member_id = p_member;
  update trusted_devices set last_used_at = now() where id = v_dev.id;
  insert into pin_attempts (tenant_id, member_id, device_id, ip, success) values (p_tenant, p_member, v_dev.id, p_ip, true);
  return query select true, null::text, null::timestamptz, v_mem.auth_user_id, v_dev.id;
end $$;
