// B2 platform: applications, provisioning, invites, subscriptions, expiry, platform billing.
// workflows W-01, W-33; decisions D-29, D-36, D-58.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

async function authUser(c) {
  const id = uuid();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
    [id, `pa-${id.slice(0, 8)}@example.invalid`]);
  return id;
}
async function platformAdmin(c) {
  const { rows } = await c.query(`insert into platform_admins (auth_user_id, display_name) values ($1, 'Test Operator') returning id`, [await authUser(c)]);
  return rows[0].id;
}
async function plan(c, features = []) {
  const { rows } = await c.query(
    `insert into plans (code, name, price_npr, billing_cycle_days, features, is_public) values ($1, 'Test plan', 12000, 365, $2, true) returning id`,
    [`p-${uuid().slice(0, 8)}`, features]);
  return rows[0].id;
}
async function apply(c, email = `owner-${uuid().slice(0, 6)}@example.invalid`, ip = null) {
  const { rows } = await c.query(
    `select submit_tenant_application('Sagarmatha Clinic', 'Ram Owner', $1, '9800000000', 'Kathmandu', 'KMC', '123456789', null, 'hello', $2, 'test') r`,
    [email, ip]);
  return rows[0].r;
}

test("applications: intake, duplicate email, per-IP rate limit, reject needs a reason", async () => {
  await withTx(async (c) => {
    const email = `dup-${uuid().slice(0, 6)}@example.invalid`;
    assert.equal(await apply(c, email), "OK");
    assert.equal(await apply(c, email.toUpperCase()), "ALREADY_SUBMITTED");
    const ip = "203.0.113.77";
    for (let i = 0; i < 5; i++) assert.equal(await apply(c, undefined, ip), "OK");
    assert.equal(await apply(c, undefined, ip), "RATE_LIMITED");
    const pa = await platformAdmin(c);
    const { rows: [a] } = await c.query(`select id from tenant_applications where lower(email) = $1`, [email]);
    await expectError(c, `select reject_tenant_application($1, '  ', $2)`, [a.id, pa], /REASON_REQUIRED/);
    await c.query(`select reject_tenant_application($1, 'Not a clinic', $2)`, [a.id, pa]);
    await expectError(c, `select reject_tenant_application($1, 'again', $2)`, [a.id, pa], /APPLICATION_NOT_OPEN/);
  });
});

test("provision_tenant creates everything a new clinic needs, atomically, once", async () => {
  await withTx(async (c) => {
    const pa = await platformAdmin(c);
    const p = await plan(c);
    const email = `own-${uuid().slice(0, 6)}@example.invalid`;
    await apply(c, email);
    const { rows: [a] } = await c.query(`select id from tenant_applications where lower(email) = $1`, [email]);
    const slug = `sag-${uuid().slice(0, 6)}`;
    const { rows: [r] } = await c.query(`select * from provision_tenant($1, $2, $3, current_date, 365, 'trial', 'inv-hash-1', $4)`, [a.id, slug, p, pa]);

    const one = async (sql) => (await c.query(sql, [r.tenant_id])).rows;
    const [t] = await one(`select status, business_type from tenants where id = $1`);
    assert.deepEqual(t, { status: "pending", business_type: "clinic_pharmacy" });
    assert.equal((await one(`select 1 from tenant_settings where tenant_id = $1`)).length, 1);
    assert.equal((await one(`select 1 from billing_profiles where tenant_id = $1 and is_default`)).length, 1);
    assert.deepEqual((await one(`select template_key from tenant_roles where tenant_id = $1 order by 1`)).map((x) => x.template_key),
      ["doctor", "lab_technician", "pharmacy", "registrar"]);
    assert.deepEqual((await one(`select kind, is_sellable from stores where tenant_id = $1 order by kind`)),
      [{ kind: "pharmacy", is_sellable: true }, { kind: "quarantine", is_sellable: false }]);
    const [m] = await one(`select membership_role, auth_user_id, email from tenant_members where tenant_id = $1`);
    assert.equal(m.membership_role, "tenant_admin");
    assert.equal(m.auth_user_id, null, "linked only when the invite is accepted");
    assert.equal(m.email, email);
    assert.ok((await one(`select tenant_paid_until($1) d`))[0].d, "has a subscription period");
    assert.equal((await one(`select count(*)::int n from ledger_accounts where tenant_id = $1`))[0].n > 20, true, "chart of accounts seeded");

    await expectError(c, `select * from provision_tenant($1, 'other-slug', $2, current_date, 365, 'trial', 'inv-hash-2', $3)`, [a.id, p, pa], /APPLICATION_NOT_OPEN/);
    await apply(c, `x-${uuid().slice(0, 6)}@example.invalid`);
    const { rows: [a2] } = await c.query(`select id from tenant_applications where status = 'submitted' order by created_at desc limit 1`);
    await expectError(c, `select * from provision_tenant($1, $2, $3, current_date, 365, 'trial', 'inv-hash-3', $4)`, [a2.id, slug, p, pa], /SLUG_TAKEN/);
    await expectError(c, `select * from provision_tenant($1, 'login', $2, current_date, 365, 'trial', 'inv-hash-4', $3)`, [a2.id, p, pa], /check|reserved/);
  });
});

test("invites: preview, accept once, reissue revokes the old link", async () => {
  await withTx(async (c) => {
    const pa = await platformAdmin(c);
    const p = await plan(c);
    const email = `inv-${uuid().slice(0, 6)}@example.invalid`;
    await apply(c, email);
    const { rows: [a] } = await c.query(`select id from tenant_applications where lower(email) = $1`, [email]);
    const { rows: [r] } = await c.query(`select * from provision_tenant($1, $2, $3, current_date, 30, 'trial', 'hash-old', $4)`, [a.id, `inv-${uuid().slice(0, 6)}`, p, pa]);

    assert.equal((await c.query(`select * from invite_preview('hash-old')`)).rows[0].email, email);
    await c.query(`select reissue_invite($1, $2, 'hash-new', $3)`, [r.tenant_id, r.member_id, pa]);
    assert.equal((await c.query(`select * from invite_preview('hash-old')`)).rows.length, 0, "old link dead");
    await expectError(c, `select * from accept_invite('hash-old', $1)`, [await authUser(c)], /INVITE_INVALID/);

    const user = await authUser(c);
    const { rows: [acc] } = await c.query(`select * from accept_invite('hash-new', $1)`, [user]);
    assert.equal(acc.member_id, r.member_id);
    assert.equal((await c.query(`select auth_user_id from tenant_members where id = $1`, [r.member_id])).rows[0].auth_user_id, user);
    await expectError(c, `select * from accept_invite('hash-new', $1)`, [await authUser(c)], /INVITE_INVALID/);
    await expectError(c, `select reissue_invite($1, $2, 'hash-3', $3)`, [r.tenant_id, r.member_id, pa], /MEMBER_NOT_INVITABLE/);
  });
});

test("expiry suspends only lapsed active tenants; a new paid period re-activates them", async () => {
  await withTx(async (c) => {
    const pa = await platformAdmin(c);
    const p = await plan(c);
    const lapsed = await makeTenant(c);
    const current = await makeTenant(c);
    const manual = await makeTenant(c);
    const pending = await makeTenant(c);
    await c.query(`update tenants set status = 'active' where id in ($1, $2, $3)`, [lapsed, current, manual]);
    await c.query(`select add_subscription_period($1, $2, current_date - 40, current_date - 10, 'paid', 100, null, $3)`, [lapsed, p, pa]);
    await c.query(`select add_subscription_period($1, $2, current_date - 5, current_date + 30, 'paid', 100, null, $3)`, [current, p, pa]);
    await c.query(`select set_tenant_status($1, 'suspended', 'Fraud check', $2)`, [manual, pa]);

    await c.query(`select suspend_expired_tenants()`);
    const status = async (t) => (await c.query(`select status, status_reason from tenants where id = $1`, [t])).rows[0];
    assert.deepEqual(await status(lapsed), { status: "suspended", status_reason: "subscription_expired" });
    assert.equal((await status(current)).status, "active");
    assert.equal((await status(pending)).status, "pending", "pending tenants are never auto-suspended");

    await c.query(`select add_subscription_period($1, $2, current_date, current_date + 364, 'paid', 12000, 'renewal', $3)`, [lapsed, p, pa]);
    assert.equal((await status(lapsed)).status, "active", "renewal re-activates an expiry suspension");
    await c.query(`select add_subscription_period($1, $2, current_date, current_date + 364, 'paid', 12000, null, $3)`, [manual, p, pa]);
    assert.equal((await status(manual)).status, "suspended", "a manual suspension is not lifted by a payment");
    await expectError(c, `select set_tenant_status($1, 'active', '', $2)`, [manual, pa], /REASON_REQUIRED/);
  });
});

test("plan features switch on plan-gated modules (lab)", async () => {
  await withTx(async (c) => {
    const pa = await platformAdmin(c);
    const t = await makeTenant(c);
    await c.query(`insert into tenant_modules (tenant_id, module_key, enabled) values ($1, 'lab', true)`, [t]);
    const mods = async () => (await c.query(`select effective_modules($1) m`, [t])).rows[0].m;
    assert.ok(!(await mods()).includes("lab"), "no plan feature, no lab");
    await c.query(`select add_subscription_period($1, $2, current_date, current_date + 30, 'trial', 0, null, $3)`, [t, await plan(c, ["lab"]), pa]);
    assert.ok((await mods()).includes("lab"), "plan with lab + toggle on → lab");
  });
});

test("platform invoices: gapless numbers, payments, no overpayment, service_role cannot write directly", async () => {
  await withTx(async (c) => {
    const pa = await platformAdmin(c);
    const t = await makeTenant(c);
    const { rows: [i1] } = await c.query(`select issue_platform_invoice($1, null, 'Annual plan', 12000, current_date + 15, $2) id`, [t, pa]);
    const { rows: [i2] } = await c.query(`select issue_platform_invoice($1, null, 'Extra', 500, null, $2) id`, [t, pa]);
    const nos = (await c.query(`select invoice_no from platform_invoices where id in ($1, $2) order by invoice_no`, [i1.id, i2.id])).rows.map((r) => r.invoice_no);
    const [n1, n2] = nos.map((n) => Number(n.split("-").pop()));
    assert.equal(n2, n1 + 1, `consecutive numbers: ${nos.join(", ")}`);
    await c.query(`select record_platform_payment($1, 7000, 'esewa', 'TXN1', current_date, $2)`, [i1.id, pa]);
    await expectError(c, `select record_platform_payment($1, 6000, 'cash', null, current_date, $2)`, [i1.id, pa], /OVERPAYMENT/);
    await c.query(`select record_platform_payment($1, 5000, 'cash', null, current_date, $2)`, [i1.id, pa]);

    await c.query(`set local role service_role`);
    await expectError(c, `insert into tenant_subscriptions (tenant_id, plan_id, starts_on, ends_on, source) values ($1, gen_random_uuid(), current_date, current_date, 'paid')`, [t], /permission denied/);
    await expectError(c, `insert into platform_invoices (tenant_id, invoice_no, fiscal_year, description, amount_npr) values ($1, 'X', '2082/83', 'x', 1)`, [t], /permission denied/);
    await expectError(c, `select token_hash from member_invites limit 1`, [], /permission denied/);
  });
});

test("paid-until follows back-to-back periods, and a gap breaks the chain", async () => {
  await withTx(async (c) => {
    const pa = await platformAdmin(c);
    const p = await plan(c);
    const t = await makeTenant(c);
    const until = async () => (await c.query(`select tenant_paid_until($1)::text d`, [t])).rows[0].d;
    await c.query(`select add_subscription_period($1, $2, current_date - 5, current_date + 10, 'trial', 0, null, $3)`, [t, p, pa]);
    const first = await until();
    await c.query(`select add_subscription_period($1, $2, current_date + 11, current_date + 375, 'paid', 1, null, $3)`, [t, p, pa]);
    const chained = await until();
    assert.ok(chained > first, `renewal added in advance extends paid-until (${first} → ${chained})`);
    await c.query(`select add_subscription_period($1, $2, current_date + 400, current_date + 500, 'paid', 1, null, $3)`, [t, p, pa]);
    assert.equal(await until(), chained, "a later period after a gap does not extend it");
  });
});

test("the app can read invite status but never the token hash", async () => {
  await withTx(async (c) => {
    await c.query(`set local role service_role`);
    await c.query(`select member_id, expires_at, used_at, revoked_at from member_invites limit 1`);
    await expectError(c, `select token_hash from member_invites limit 1`, [], /permission denied/);
  });
});

test("Super Admin creates a clinic directly: same provisioning, admin + one-time setup link, no duplicates", async () => {
  await withTx(async (c) => {
    const pa = await platformAdmin(c);
    const p = await plan(c);
    const slug = `direct-${uuid().slice(0, 6)}`;
    const email = `admin-${uuid().slice(0, 6)}@example.invalid`;
    const create = (o = {}) => c.query(
      `select * from create_tenant_direct($1, $2, 'Sita Sharma', $3, '9841000000', 'Lalitpur', 'Lalitpur Metro', $4, $5, current_date, 30, 'trial', $6, $7)`,
      [o.name ?? "Sunrise Clinic", o.slug ?? slug, o.email ?? email, o.pan ?? "301234567", p, o.token ?? `tok-${uuid()}`, o.by ?? pa]);
    await c.query(`set role service_role`);
    const { rows: [r] } = await create({ token: "direct-token-1" });
    await c.query(`reset role`);
    const { rows: [t] } = await c.query(`select status, name, pan_number from tenants where id = $1`, [r.tenant_id]);
    assert.deepEqual([t.status, t.name, t.pan_number], ["pending", "Sunrise Clinic", "301234567"], "pending until the clinic admin finishes setup and goes live");
    const { rows: [m] } = await c.query(`select membership_role, email, auth_user_id from tenant_members where id = $1`, [r.member_id]);
    assert.deepEqual([m.membership_role, m.email, m.auth_user_id], ["tenant_admin", email, null], "admin created, waiting for the setup link");
    const { rows: [app] } = await c.query(`select source, status from tenant_applications where tenant_id = $1`, [r.tenant_id]);
    assert.deepEqual([app.source, app.status], ["direct", "approved"], "recorded as a direct, approved application");
    const counts = (await c.query(`select (select count(*) from tenant_roles where tenant_id = $1)::int roles, (select count(*) from stores where tenant_id = $1)::int stores,
      (select count(*) from tenant_subscriptions where tenant_id = $1)::int subs, (select count(*) from ledger_accounts where tenant_id = $1)::int accounts`, [r.tenant_id])).rows[0];
    assert.deepEqual(counts, { roles: 4, stores: 2, subs: 1, accounts: 30 }, "exactly what an approved application gets");
    assert.equal((await c.query(`select count(*)::int n from invite_preview('direct-token-1')`)).rows[0].n, 1, "the setup link works");
    await c.query(`set role service_role`);
    await expectError(c, `select * from create_tenant_direct('Other', $1, 'X Y', 'x@example.invalid', '9841000000', null, null, null, $2, current_date, 30, 'trial', 't2', $3)`, [slug, p, pa], /SLUG_TAKEN/);
    await expectError(c, `select * from create_tenant_direct('Other', $1, 'X Y', $2, '9841000000', null, null, null, $3, current_date, 30, 'trial', 't3', $4)`, [`${slug}-b`, email, p, pa], /ADMIN_EMAIL_IN_USE/);
    await expectError(c, `select * from create_tenant_direct('Other', $1, 'X Y', 'y@example.invalid', '9841000000', null, null, '12', $2, current_date, 30, 'trial', 't4', $3)`, [`${slug}-c`, p, pa], /BAD_PAN/);
    await expectError(c, `select * from create_tenant_direct('Other', $1, 'X Y', 'z@example.invalid', '9841000000', null, null, null, $2, current_date, 30, 'trial', 't5', $3)`, [`${slug}-d`, p, uuid()], /NOT_PLATFORM_ADMIN/);
    await c.query(`reset role`);
  });
});
