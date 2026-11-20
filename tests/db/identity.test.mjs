// B1 identity & access, proven in the database. permissions.md §2–§6, §12; D-06, D-27, D-30, D-52.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

async function authUser(c) {
  const id = uuid();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
    [id, `t-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function member(c, tenant, { admin = false, auth = true, name = "Test Person", username = null } = {}) {
  const authId = auth ? await authUser(c) : null;
  const { rows } = await c.query(
    `insert into tenant_members (tenant_id, auth_user_id, membership_role, display_name, email, username)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [tenant, authId, admin ? "tenant_admin" : "tenant_member", name, admin || !username ? `${uuid().slice(0, 8)}@example.invalid` : null, username]);
  return { id: rows[0].id, authId };
}

async function giveRole(c, tenant, memberId, templateKey) {
  await c.query(`select seed_role_templates($1)`, [tenant]);
  const { rows } = await c.query(`select id from tenant_roles where tenant_id = $1 and template_key = $2`, [tenant, templateKey]);
  await c.query(`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [tenant, memberId, rows[0].id]);
}

const perms = async (c, m) => (await c.query(`select effective_permissions($1) p`, [m])).rows[0].p;

test("modules: a launch tenant gets the 7 MVP modules; toggles and dependencies apply", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const mods = async () => (await c.query(`select effective_modules($1) m`, [t])).rows[0].m;
    assert.deepEqual(await mods(), ["appointments", "consultation", "expenses_finance", "inventory", "pharmacy_counter", "purchasing", "website"]);
    await c.query(`insert into tenant_modules (tenant_id, module_key, enabled) values ($1, 'inventory', false)`, [t]);
    assert.deepEqual(await mods(), ["appointments", "consultation", "expenses_finance", "website"]);
  });
});

test("tenant admin holds every operational key but NO clinical key (D-06)", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const a = await member(c, t, { admin: true });
    const p = await perms(c, a.id);
    for (const k of ["manage_staff", "manage_settings", "view_finance", "manage_billing", "manage_purchases"]) assert.ok(p.includes(k), k);
    for (const k of ["view_clinical", "write_consultation", "issue_prescriptions", "dispense_prescription"]) assert.ok(!p.includes(k), k);
  });
});

test("clinical keys need a VERIFIED, unexpired credential, verified by someone else (D-30, D-52)", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const admin = await member(c, t, { admin: true });
    const doc = await member(c, t, { name: "Dr Test" });
    await giveRole(c, t, doc.id, "doctor");
    let p = await perms(c, doc.id);
    assert.ok(p.includes("view_patients") && !p.includes("write_consultation"), "role alone gives no clinical keys");

    const { rows: [cred] } = await c.query(
      `insert into member_credentials (tenant_id, member_id, profession, council, registration_no) values ($1, $2, 'doctor', 'NMC', 'T-1') returning id`,
      [t, doc.id]);
    await expectError(c, `select verify_member_credential($1, $2, null)`, [cred.id, doc.id], /CANNOT_VERIFY_OWN_CREDENTIAL/);
    const other = await member(c, t);
    await expectError(c, `select verify_member_credential($1, $2, null)`, [cred.id, other.id], /VERIFIER_NOT_TENANT_ADMIN/);
    await expectError(c, `select verify_member_credential($1, null, null)`, [cred.id], /ONE_VERIFIER_REQUIRED/);
    await c.query(`select verify_member_credential($1, $2, null)`, [cred.id, admin.id]);
    p = await perms(c, doc.id);
    for (const k of ["view_clinical", "write_consultation", "issue_prescriptions", "record_vitals"]) assert.ok(p.includes(k), k);
    assert.ok(!p.includes("dispense_prescription"), "a doctor credential does not grant pharmacist keys");

    await c.query(`update member_credentials set expires_on = current_date - 1 where id = $1`, [cred.id]);
    assert.ok(!(await perms(c, doc.id)).includes("write_consultation"), "expired credential switches clinical keys off");
  });
});

test("overrides, module switches and unknown keys", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const m = await member(c, t);
    await giveRole(c, t, m.id, "registrar");
    assert.ok((await perms(c, m.id)).includes("manage_billing"));
    await c.query(`insert into member_permission_overrides (tenant_id, member_id, permission, effect) values ($1, $2, 'manage_billing', 'revoke')`, [t, m.id]);
    await c.query(`insert into member_permission_overrides (tenant_id, member_id, permission, effect) values ($1, $2, 'add_expenses', 'grant')`, [t, m.id]);
    let p = await perms(c, m.id);
    assert.ok(!p.includes("manage_billing") && p.includes("add_expenses"));
    await c.query(`insert into tenant_modules (tenant_id, module_key, enabled) values ($1, 'appointments', false)`, [t]);
    p = await perms(c, m.id);
    assert.ok(!p.includes("view_appointments") && p.includes("view_patients"), "module off removes its keys only");
    await expectError(c, `insert into tenant_roles (tenant_id, name, permissions) values ($1, 'Bad', array['not_a_key'])`, [t], /UNKNOWN_PERMISSION/);
    await c.query(`update tenant_members set is_active = false where id = $1`, [m.id]);
    assert.deepEqual(await perms(c, m.id), [], "a deactivated member has nothing");
  });
});

test("P-18: tenant admins need an email; staff may use a username", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    await expectError(c, `insert into tenant_members (tenant_id, membership_role, display_name, username) values ($1, 'tenant_admin', 'No Email', 'boss')`, [t], /check/);
    await c.query(`insert into tenant_members (tenant_id, display_name, username) values ($1, 'Desk One', 'desk1')`, [t]);
    await expectError(c, `insert into tenant_members (tenant_id, display_name, username) values ($1, 'Desk Two', 'DESK1')`, [t], /check|duplicate/);
  });
});

test("PIN: trusted device only, 6 digits, lockout after 5, picker never public", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    await c.query(`update tenants set status = 'active' where id = $1`, [t]);
    await c.query(`insert into tenant_settings (tenant_id) values ($1)`, [t]);
    const admin = await member(c, t, { admin: true });
    const m = await member(c, t, { name: "Desk Person" });

    await expectError(c, `select set_member_pin($1, $2, '111111')`, [t, m.id], /PIN_TOO_SIMPLE/);
    await expectError(c, `select set_member_pin($1, $2, '234567')`, [t, m.id], /PIN_TOO_SIMPLE/);
    await expectError(c, `select set_member_pin($1, $2, '1234')`, [t, m.id], /PIN_FORMAT/);
    await c.query(`select set_member_pin($1, $2, '480715')`, [t, m.id]);

    const verify = async (pin, hash) => (await c.query(`select * from verify_pin($1, $2, $3, $4)`, [t, m.id, pin, hash])).rows[0];
    assert.equal((await verify("480715", "unknown-device")).reason, "DEVICE_NOT_TRUSTED");
    assert.deepEqual((await c.query(`select * from device_staff_picker($1, 'unknown-device')`, [t])).rows, [], "no staff list on an untrusted device");

    const { rows: [d] } = await c.query(`select enroll_trusted_device($1, 'Reception PC', 'hash-1', $2) id`, [t, admin.id]);
    const picker = (await c.query(`select * from device_staff_picker($1, 'hash-1')`, [t])).rows;
    assert.deepEqual(picker.map((r) => r.display_name), ["Desk Person"], "only PIN-enabled members are listed");

    const ok = await verify("480715", "hash-1");
    assert.equal(ok.ok, true);
    assert.equal(ok.auth_user_id, m.authId);
    assert.equal(ok.device_id, d.id);

    for (let i = 0; i < 4; i++) assert.equal((await verify("000001", "hash-1")).reason, "BAD_PIN");
    assert.equal((await verify("000001", "hash-1")).reason, "PIN_LOCKED", "5th failure locks");
    assert.equal((await verify("480715", "hash-1")).reason, "PIN_LOCKED", "even the right PIN is refused while locked");

    await c.query(`select require_pin_change($1, $2)`, [t, m.id]); // also clears the lock
    assert.equal((await verify("480715", "hash-1")).reason, "PIN_NOT_SET", "admin reset forces a new PIN");
    await c.query(`select set_member_pin($1, $2, '592618')`, [t, m.id]);
    assert.equal((await verify("592618", "hash-1")).ok, true);

    await c.query(`update tenant_settings set pin_policy = 'off' where tenant_id = $1`, [t]);
    assert.equal((await verify("592618", "hash-1")).reason, "NOT_ALLOWED");
    await c.query(`update tenant_settings set pin_policy = 'allowed' where tenant_id = $1`, [t]);

    await c.query(`select revoke_trusted_device($1, $2, $3)`, [t, d.id, admin.id]);
    assert.equal((await verify("592618", "hash-1")).reason, "DEVICE_NOT_TRUSTED");
    assert.deepEqual((await c.query(`select * from device_staff_picker($1, 'hash-1')`, [t])).rows, []);

    // A device of tenant A is useless for tenant B.
    const t2 = await makeTenant(c);
    assert.equal((await c.query(`select * from verify_pin($1, $2, '592618', 'hash-1')`, [t2, m.id])).rows[0].reason, "DEVICE_NOT_TRUSTED");
  });
});

test("service_role cannot read PIN hashes or attempts, only call the functions", async () => {
  await withTx(async (c) => {
    await c.query(`set local role service_role`);
    await expectError(c, `select * from member_pins limit 1`, [], /permission denied/);
    await expectError(c, `select * from pin_attempts limit 1`, [], /permission denied/);
    await expectError(c, `insert into trusted_devices (tenant_id, name, token_hash, enrolled_by) values (gen_random_uuid(), 'x', 'y', gen_random_uuid())`, [], /permission denied/);
    await expectError(c, `update member_credentials set verified_at = now()`, [], /permission denied/);
    await expectError(c, `delete from tenant_members`, [], /permission denied/);
  });
});

test("password lockout: 10 failures in 15 minutes lock; a success clears", async () => {
  await withTx(async (c) => {
    const h = `test-${uuid()}`;
    const status = async () => (await c.query(`select * from password_lockout_status($1)`, [h])).rows[0];
    for (let i = 0; i < 9; i++) await c.query(`select record_login_attempt($1, false)`, [h]);
    assert.equal((await status()).locked, false);
    await c.query(`select record_login_attempt($1, false)`, [h]);
    assert.equal((await status()).locked, true);
    await c.query(`select record_login_attempt($1, true)`, [h]);
    assert.equal((await status()).locked, false);
  });
});

test("resolve_request_context: one call returns tenant, member, permissions, modules and assurance", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c, { slug: `ctx-${uuid().slice(0, 6)}` });
    await c.query(`insert into tenant_settings (tenant_id) values ($1)`, [t]);
    const m = await member(c, t, { name: "Reg One" });
    await giveRole(c, t, m.id, "registrar");
    const session = uuid();
    await c.query(`insert into session_assurance (session_id, auth_user_id, tenant_id, member_id, level, method, password_auth_at)
                   values ($1, $2, $3, $4, 'A2', 'password', now())`, [session, m.authId, t, m.id]);
    await c.query(`set local role service_role`);
    const { rows: [{ ctx }] } = await c.query(`select resolve_request_context($1, $2) ctx`, [m.authId, session]);
    assert.equal(ctx.tenant_id, t);
    assert.equal(ctx.member_id, m.id);
    assert.equal(ctx.membership_role, "tenant_member");
    assert.equal(ctx.assurance.level, "A2");
    assert.ok(ctx.permissions.includes("manage_queue"));
    assert.ok(ctx.modules.includes("appointments"));
    assert.equal(ctx.roles[0].home_route, "/employee/registrar");
    assert.equal((await c.query(`select resolve_request_context($1, $2) ctx`, [uuid(), session])).rows[0].ctx, null, "a stranger gets nothing");
    const other = (await c.query(`select resolve_request_context($1, $2) ctx`, [m.authId, uuid()])).rows[0].ctx;
    assert.equal(other.assurance, null, "another session's assurance is never borrowed");
  });
});
