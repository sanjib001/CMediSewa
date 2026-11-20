// B3 tenant setup: schedules & availability, public website read, staff invites/roles,
// go-live, and the TWO-TENANT ISOLATION suite (roadmap B3 exit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

async function authUser(c) {
  const id = uuid();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
    [id, `s-${id.slice(0, 8)}@example.invalid`]);
  return id;
}
async function member(c, t, { admin = false, name = "Staff Person" } = {}) {
  const { rows } = await c.query(
    `insert into tenant_members (tenant_id, auth_user_id, membership_role, display_name, email) values ($1, $2, $3, $4, $5) returning id`,
    [t, await authUser(c), admin ? "tenant_admin" : "tenant_member", name, `m-${uuid().slice(0, 8)}@example.invalid`]);
  return rows[0].id;
}
async function doctor(c, t, { verified = true, isPublic = true } = {}) {
  const m = await member(c, t, { name: "Dr. Test Doctor" });
  await c.query(`insert into doctor_profiles (tenant_id, member_id, specialty, consultation_fee, is_public) values ($1, $2, 'General medicine', 500, $3)`, [t, m, isPublic]);
  const { rows: [cr] } = await c.query(`insert into member_credentials (tenant_id, member_id, profession, council, registration_no) values ($1, $2, 'doctor', 'NMC', $3) returning id`, [t, m, `R-${uuid().slice(0, 6)}`]);
  if (verified) {
    const admin = await member(c, t, { admin: true, name: "Verifier Admin" });
    await c.query(`select verify_member_credential($1, $2, null)`, [cr.id, admin]);
  }
  return m;
}
// A fixed future Sunday keeps the date maths independent of today.
const SUNDAY = "2027-01-03";

test("schedules: overlap refused, slot XOR token, effective dating", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const d = await doctor(c, t);
    const ins = (start, end, extra = "slot_minutes", v = 15, from = "2027-01-01") => c.query(
      `insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, ${extra}, effective_from) values ($1, $2, 0, $3, $4, $5, $6)`,
      [t, d, start, end, v, from]);
    await ins("09:00", "10:00");
    await expectError(c, `insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes, effective_from) values ($1, $2, 0, '09:30', '11:00', 15, '2027-01-01')`, [t, d], /exclusion|conflicting|23P01/);
    await ins("10:00", "11:00", "max_tokens", 20); // adjacent window is fine
    await expectError(c, `insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, effective_from) values ($1, $2, 1, '09:00', '10:00', '2027-01-01')`, [t, d], /check/);
    await expectError(c, `insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes, max_tokens) values ($1, $2, 1, '09:00', '10:00', 15, 10)`, [t, d], /check/);
  });
});

test("available_slots: slots and tokens in Kathmandu time, leave and modified days", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const d = await doctor(c, t);
    // Sunday: a 15-minute slot window in the morning and a token OPD in the afternoon.
    await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes, room, effective_from)
                   values ($1, $2, 0, '09:00', '10:00', 15, 'Room 2', '2027-01-01')`, [t, d]);
    await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, max_tokens, room, effective_from)
                   values ($1, $2, 0, '15:00', '17:00', 25, 'Room 2', '2027-01-01')`, [t, d]);
    const slots = async (from, to) => (await c.query(`select slot_start, mode, capacity from available_slots($1, $2, $3, $4) order by 1`, [t, d, from, to])).rows;

    const sun = await slots(SUNDAY, SUNDAY);
    const slotRows = sun.filter((r) => r.mode === "slot");
    const tokenRows = sun.filter((r) => r.mode === "token");
    assert.equal(slotRows.length, 4, "09:00–10:00 in 15-minute slots");
    assert.equal(slotRows[0].slot_start.toISOString(), "2027-01-03T03:15:00.000Z", "09:00 Kathmandu = 03:15 UTC");
    assert.equal(tokenRows.length, 1);
    assert.equal(tokenRows[0].capacity, 25);
    assert.equal((await slots("2027-01-04", "2027-01-09")).length, 0, "no OPD Monday–Saturday");

    await c.query(`insert into schedule_exceptions (tenant_id, member_id, on_date, kind, start_time, end_time) values ($1, $2, $3, 'leave', '09:15', '09:45')`, [t, d, SUNDAY]);
    assert.equal((await slots(SUNDAY, SUNDAY)).filter((r) => r.mode === "slot").length, 2, "partial leave removes overlapping slots");
    await c.query(`insert into schedule_exceptions (tenant_id, member_id, on_date, kind) values ($1, $2, '2027-01-10', 'leave')`, [t, d]);
    assert.equal((await slots("2027-01-10", "2027-01-10")).length, 0, "whole-day leave");
    await c.query(`insert into schedule_exceptions (tenant_id, member_id, on_date, kind, start_time, end_time, slot_minutes) values ($1, $2, '2027-01-17', 'modified', '12:00', '12:30', 10)`, [t, d]);
    const mod = await slots("2027-01-17", "2027-01-17");
    assert.equal(mod.length, 3, "a modified day replaces the template");
    await c.query(`insert into schedule_exceptions (tenant_id, member_id, on_date, kind, start_time, end_time, max_tokens) values ($1, $2, '2027-01-05', 'extra', '18:00', '19:00', 10)`, [t, d]);
    assert.equal((await slots("2027-01-05", "2027-01-05")).length, 1, "an extra OPD adds a window on a non-OPD day");
  });
});

test("public_clinic_profile: only active + published; allow-listed fields; verified doctors only", async () => {
  await withTx(async (c) => {
    const slug = `pub-${uuid().slice(0, 6)}`;
    const t = await makeTenant(c, { slug });
    const prof = async () => (await c.query(`select public_clinic_profile($1) p`, [slug])).rows[0].p;
    await c.query(`insert into site_settings (tenant_id, published) values ($1, true)`, [t]);
    assert.equal(await prof(), null, "pending clinic: nothing public");
    await c.query(`update tenants set status = 'active' where id = $1`, [t]);
    await c.query(`update site_settings set published = false where tenant_id = $1`, [t]);
    assert.equal(await prof(), null, "unpublished website: nothing public");
    await c.query(`update site_settings set published = true where tenant_id = $1`, [t]);

    const shown = await doctor(c, t);
    await doctor(c, t, { verified: false });
    await doctor(c, t, { isPublic: false });
    await c.query(`insert into services (tenant_id, name, price_npr) values ($1, 'General OPD', 500), ($1, 'Hidden one', 100)`, [t]);
    await c.query(`update services set is_public = false where tenant_id = $1 and name = 'Hidden one'`, [t]);
    let p = await prof();
    assert.deepEqual(p.doctors.map((x) => x.id), [shown], "only public doctors with a verified credential");
    assert.deepEqual(p.services.map((x) => x.name), ["General OPD"]);
    assert.equal(p.services[0].price, 500);
    const blob = JSON.stringify(p);
    assert.ok(!blob.includes("@example.invalid"), "no staff emails leak");
    assert.ok(!/auth_user_id|tenant_id|"mrn"|password/.test(blob), "no internal fields leak");
    await c.query(`update site_settings set show_prices = false where tenant_id = $1`, [t]);
    p = await prof();
    assert.equal(p.services[0].price, null, "prices hidden when the clinic chooses");
  });
});

test("staff: invite with roles, role changes audited, the last admin cannot be deactivated", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    await c.query(`select seed_role_templates($1)`, [t]);
    const admin = await member(c, t, { admin: true });
    const { rows: [reg] } = await c.query(`select id from tenant_roles where tenant_id = $1 and template_key = 'registrar'`, [t]);
    const { rows: [{ id: m }] } = await c.query(`select invite_member($1, 'New Registrar', null, 'reg2', 'Front desk', 'tenant_member', array[$2]::uuid[], 'tok-1', $3) id`, [t, reg.id, admin]);
    assert.ok((await c.query(`select effective_permissions($1) p`, [m])).rows[0].p.includes("manage_queue"));
    const { rows: [ph] } = await c.query(`select id from tenant_roles where tenant_id = $1 and template_key = 'pharmacy'`, [t]);
    await c.query(`select set_member_roles($1, $2, array[$3]::uuid[], $4)`, [t, m, ph.id, admin]);
    const p = (await c.query(`select effective_permissions($1) p`, [m])).rows[0].p;
    assert.ok(p.includes("pharmacy_sell") && !p.includes("manage_queue"));
    assert.equal((await c.query(`select count(*)::int n from audit_log where target_id = $1 and action = 'member.roles_change'`, [String(m)])).rows[0].n, 1);
    await expectError(c, `select set_member_active($1, $2, false, $2)`, [t, admin], /LAST_ADMIN/);
    await c.query(`select set_member_active($1, $2, false, $3)`, [t, m, admin]);
    assert.deepEqual((await c.query(`select effective_permissions($1) p`, [m])).rows[0].p, []);
  });
});

test("go-live: blockers listed until the clinic is ready, then pending → active", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const admin = await member(c, t, { admin: true });
    let r = (await c.query(`select go_live($1, $2) b`, [t, admin])).rows[0].b;
    assert.deepEqual(r.sort(), ["billing_profile", "clinic_phone", "consultation_service", "doctor_with_schedule", "pharmacy_store"].sort());
    await c.query(`update tenants set phone = '01-5551234' where id = $1`, [t]);
    const { rows: [bp] } = await c.query(`insert into billing_profiles (tenant_id, name, legal_name, is_default) values ($1, 'Clinic', 'Test Clinic Pvt Ltd', true) returning id`, [t]);
    await c.query(`insert into services (tenant_id, name, price_npr) values ($1, 'General OPD', 500)`, [t]);
    await c.query(`insert into stores (tenant_id, code, name, kind, billing_profile_id, is_sellable) values ($1, 'PHARM', 'Pharmacy', 'pharmacy', $2, true)`, [t, bp.id]);
    const d = await doctor(c, t);
    r = (await c.query(`select go_live($1, $2) b`, [t, admin])).rows[0].b;
    assert.deepEqual(r, ["doctor_with_schedule"]);
    await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes) values ($1, $2, 1, '09:00', '12:00', 15)`, [t, d]);
    r = (await c.query(`select go_live($1, $2) b`, [t, admin])).rows[0].b;
    assert.deepEqual(r, []);
    assert.equal((await c.query(`select status from tenants where id = $1`, [t])).rows[0].status, "active");
    const other = await member(c, t);
    await expectError(c, `select go_live($1, $2)`, [t, other], /NOT_TENANT_ADMIN/);
  });
});

test("ISOLATION: nothing in clinic A can reference clinic B's rows (composite FKs)", async () => {
  await withTx(async (c) => {
    const a = await makeTenant(c);
    const b = await makeTenant(c);
    await c.query(`select seed_role_templates($1)`, [b]);
    const docA = await doctor(c, a);
    const memA = await member(c, a);
    const memB = await member(c, b);
    const { rows: [deptB] } = await c.query(`insert into departments (tenant_id, name) values ($1, 'Dept B') returning id`, [b]);
    const { rows: [svcB] } = await c.query(`insert into services (tenant_id, name, price_npr) values ($1, 'Svc B', 1) returning id`, [b]);
    const { rows: [roleB] } = await c.query(`select id from tenant_roles where tenant_id = $1 limit 1`, [b]);
    const { rows: [bpB] } = await c.query(`insert into billing_profiles (tenant_id, name, legal_name, is_default) values ($1, 'B', 'B Ltd', true) returning id`, [b]);
    const { rows: [storeB] } = await c.query(`insert into stores (tenant_id, code, name, kind, billing_profile_id) values ($1, 'MAIN', 'Main', 'main', $2) returning id`, [b, bpB.id]);
    const fk = /23503|foreign key/;
    const cases = [
      [`insert into services (tenant_id, department_id, name, price_npr) values ($1, $2, 'Cross service', 1)`, [a, deptB.id], "A service in B's department"],
      [`insert into doctor_services (tenant_id, member_id, service_id) values ($1, $2, $3)`, [a, docA, svcB.id], "A doctor offering B's service"],
      [`insert into doctor_departments (tenant_id, member_id, department_id) values ($1, $2, $3)`, [a, docA, deptB.id], "A doctor in B's department"],
      [`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes) values ($1, $2, 1, '09:00', '10:00', 15)`, [a, memB], "A schedule for B's member"],
      [`insert into doctor_profiles (tenant_id, member_id) values ($1, $2)`, [a, memB], "A doctor profile for B's member"],
      [`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [a, memA, roleB.id], "A member with B's role"],
      [`insert into store_members (tenant_id, store_id, member_id, access) values ($1, $2, $3, 'manage')`, [a, storeB.id, memA], "A member in B's store"],
      [`insert into member_credentials (tenant_id, member_id, profession, council, registration_no) values ($1, $2, 'nurse', 'NNC', 'X1')`, [a, memB], "A credential for B's member"],
      [`insert into stores (tenant_id, code, name, kind, billing_profile_id) values ($1, 'XS', 'Cross store', 'main', $2)`, [a, bpB.id], "A store under B's billing profile"],
      [`insert into site_settings (tenant_id, updated_by) values ($1, $2)`, [a, memB], "A website edited by B's member"],
    ];
    for (const [sql, params, label] of cases) await expectError(c, sql, params, fk).catch((e) => { throw new Error(`${label}: ${e.message}`); });
    await expectError(c, `select invite_member($1, 'X', null, 'x1', null, 'tenant_member', null, 'tok-x', $2)`, [a, memB], /MEMBER_NOT_FOUND/);
    await expectError(c, `select set_member_roles($1, $2, array[$3]::uuid[], $4)`, [a, memB, roleB.id, memA], /MEMBER_NOT_FOUND/);
    await expectError(c, `select set_member_active($1, $2, false, $3)`, [a, memB, memA], /MEMBER_NOT_FOUND/);
    assert.equal((await c.query(`select count(*)::int n from available_slots($1, $2, '2027-01-01', '2027-01-31')`, [b, docA])).rows[0].n, 0, "B cannot read A's doctor's slots");
  });
});

test("credentials: editing the number clears verification; save_role audits and validates keys", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const d = await doctor(c, t);
    await c.query(`update member_credentials set registration_no = 'CHANGED-1' where member_id = $1`, [d]);
    assert.equal((await c.query(`select verified_at from member_credentials where member_id = $1`, [d])).rows[0].verified_at, null);
    const admin = await member(c, t, { admin: true });
    const { rows: [{ id }] } = await c.query(`select save_role($1, null, 'Night desk', null, array['manage_queue'], '/employee/registrar', $2) id`, [t, admin]);
    await c.query(`select save_role($1, $2, 'Night desk', 'Evenings', array['manage_queue','view_patients'], '/employee/registrar', $3)`, [t, id, admin]);
    assert.equal((await c.query(`select count(*)::int n from audit_log where target_id = $1`, [String(id)])).rows[0].n, 2);
    await expectError(c, `select save_role($1, $2, 'Night desk', null, array['not_a_key'], '/employee/registrar', $3)`, [t, id, admin], /./);
  });
});
