// U3b patients: duplicate matches and clearing the flag, isolation. RPCs run as service_role, like the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

async function authUser(c) {
  const id = uuid();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`, [id, `br-${id.slice(0, 8)}@example.invalid`]);
  return id;
}
async function member(c, t, admin = false) {
  const { rows: [m] } = await c.query(`insert into tenant_members (tenant_id, auth_user_id, membership_role, display_name, email) values ($1, $2, $3, 'Staff', $4) returning id`,
    [t, await authUser(c), admin ? "tenant_admin" : "tenant_member", `m-${uuid().slice(0, 8)}@example.invalid`]);
  return m.id;
}
/** A live clinic with a published site taking requests, and a public verified doctor (every day 09:00–12:00, 15-min slots; 15:00–17:00 tokens × 2). */
async function clinic(c, { verified = true } = {}) {
  const slug = `br-${uuid().slice(0, 8)}`;
  const t = await makeTenant(c, { slug });
  await c.query(`update tenants set status = 'active' where id = $1`, [t]);
  await c.query(`insert into tenant_settings (tenant_id, min_notice_minutes) values ($1, 0)`, [t]);
  await c.query(`insert into site_settings (tenant_id, published) values ($1, true)`, [t]);
  const admin = await member(c, t, true), desk = await member(c, t), doc = await member(c, t);
  await c.query(`insert into doctor_profiles (tenant_id, member_id, consultation_fee) values ($1, $2, 500)`, [t, doc]);
  const { rows: [cr] } = await c.query(`insert into member_credentials (tenant_id, member_id, profession, council, registration_no) values ($1, $2, 'doctor', 'NMC', $3) returning id`, [t, doc, `R-${uuid().slice(0, 8)}`]);
  if (verified) await c.query(`select verify_member_credential($1, $2, null)`, [cr.id, admin]);
  await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes, effective_from) select $1, $2, w, '09:00', '12:00', 15, current_date - 1 from generate_series(0, 6) w`, [t, doc]);
  await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, max_tokens, effective_from) select $1, $2, w, '15:00', '17:00', 2, current_date - 1 from generate_series(0, 6) w`, [t, doc]);
  return { t, slug, admin, desk, doc };
}
const asApp = (c) => c.query(`set role service_role`);
const asOwner = (c) => c.query(`reset role`);

// ── U3b patient duplicates ──
const reg = (c, t, name, phone, dob = null) => c.query(`insert into patients (tenant_id, full_name, sex, age_years, date_of_birth, phone) values ($1, $2, 'female', $3, $4, $5) returning id, possible_duplicate`,
  [t, name, dob ? null : 30, dob, phone]).then((r) => r.rows[0]);

test("duplicate flag: matches shown with the reason; cleared only by someone who manages patients; audited", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const a = await reg(c, x.t, "Asha Lama", "9841000001");
    const b = await reg(c, x.t, "Asha K. Lama", "984-100-0001");
    const d1 = await reg(c, x.t, "Ram Thapa", null, "1990-05-01");
    const d2 = await reg(c, x.t, "ram thapa", null, "1990-05-01");
    assert.deepEqual([a.possible_duplicate, b.possible_duplicate, d1.possible_duplicate, d2.possible_duplicate], [false, true, false, true]);
    await asApp(c);
    const m = (await c.query(`select id, why from patient_duplicate_candidates($1, $2)`, [x.t, b.id])).rows;
    assert.deepEqual(m.map((r) => [r.id, r.why]), [[a.id, "same phone and first name"]]);
    assert.equal((await c.query(`select why from patient_duplicate_candidates($1, $2)`, [x.t, d2.id])).rows[0].why, "same name and date of birth");
    await expectError(c, `select clear_duplicate_flag($1, $2, $3, 'checked')`, [x.t, b.id, x.desk], /NO_PERMISSION/);
    await c.query(`select clear_duplicate_flag($1, $2, $3, 'Mother and daughter, same phone')`, [x.t, b.id, x.admin]);
    await expectError(c, `select clear_duplicate_flag($1, $2, $3, 'again')`, [x.t, b.id, x.admin], /NOT_FLAGGED/);
    await expectError(c, `update patients set possible_duplicate = true where id = $1`, [b.id], /permission denied/);
    await asOwner(c);
    const { rows: [p] } = await c.query(`select possible_duplicate from patients where id = $1`, [b.id]);
    assert.equal(p.possible_duplicate, false);
    await c.query(`update patients set phone = '9841000009' where id = $1`, [b.id]);
    assert.equal((await c.query(`select possible_duplicate from patients where id = $1`, [b.id])).rows[0].possible_duplicate, false, "editing details doesn't re-flag");
    const { rows: [au] } = await c.query(`select reason, patient_id from audit_log where tenant_id = $1 and action = 'patient.duplicate_cleared'`, [x.t]);
    assert.deepEqual([au.reason, au.patient_id], ["Mother and daughter, same phone", b.id]);
  });
});

test("ISOLATION: another clinic's patients are never candidates and can't be cleared", async () => {
  await withTx(async (c) => {
    const x = await clinic(c), y = await clinic(c);
    await reg(c, x.t, "Asha Lama", "9841000001");
    const yb = await reg(c, y.t, "Asha Lama", "9841000001");
    assert.equal(yb.possible_duplicate, false, "the same person at another clinic isn't a duplicate");
    const xb = await reg(c, x.t, "Asha Lama", "9841000001");
    await asApp(c);
    assert.equal((await c.query(`select count(*)::int n from patient_duplicate_candidates($1, $2)`, [y.t, xb.id])).rows[0].n, 0);
    await expectError(c, `select clear_duplicate_flag($1, $2, $3, 'x')`, [y.t, xb.id, y.admin], /NOT_FLAGGED/);
    await asOwner(c);
  });
});
