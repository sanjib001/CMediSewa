// M-37 patient merge: everything of the duplicate moves to the kept record (locked clinical
// rows too), the duplicate hides and its MRN still finds the person; undo moves exactly those
// rows back. Refusals, permission, isolation. RPCs run as service_role, like the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

async function authUser(c) {
  const id = uuid();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`, [id, `pm-${id.slice(0, 8)}@example.invalid`]);
  return id;
}
async function member(c, t, { admin = false, name = "Staff" } = {}) {
  const { rows: [m] } = await c.query(`insert into tenant_members (tenant_id, auth_user_id, membership_role, display_name, email) values ($1, $2, $3, $4, $5) returning id`,
    [t, await authUser(c), admin ? "tenant_admin" : "tenant_member", name, `m-${uuid().slice(0, 8)}@example.invalid`]);
  return m.id;
}
/** An active clinic: billing profile, an admin, a desk member without keys, a doctor with a daily schedule, an OPD service. */
async function clinic(c) {
  const t = await makeTenant(c);
  await c.query(`update tenants set status = 'active' where id = $1`, [t]);
  const { rows: [bp] } = await c.query(`insert into billing_profiles (tenant_id, name, legal_name, invoice_prefix, is_default) values ($1, 'Clinic', 'Test Clinic', 'T', true) returning id`, [t]);
  await c.query(`insert into tenant_settings (tenant_id, default_billing_profile_id, min_notice_minutes, allow_credit, credit_limit_per_patient) values ($1, $2, 0, true, 5000)`, [t, bp.id]);
  const admin = await member(c, t, { admin: true }), desk = await member(c, t), doc = await member(c, t, { name: "Dr. Merge Test" });
  await c.query(`insert into doctor_profiles (tenant_id, member_id, consultation_fee) values ($1, $2, 500)`, [t, doc]);
  await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes, effective_from)
                 select $1, $2, w, '00:00', '23:45', 15, current_date - 1 from generate_series(0, 6) w`, [t, doc]);
  const { rows: [svc] } = await c.query(`insert into services (tenant_id, name, kind, price_npr) values ($1, 'General OPD', 'consultation', 300) returning id`, [t]);
  return { t, admin, desk, doc, svc: svc.id };
}
const reg = (c, t, name, phone) => c.query(`insert into patients (tenant_id, full_name, sex, age_years, phone) values ($1, $2, 'female', 30, $3) returning id, mrn, possible_duplicate`, [t, name, phone]).then((r) => r.rows[0]);
const asApp = (c) => c.query(`set role service_role`);
const asOwner = (c) => c.query(`reset role`);
const checkIn = (c, x, p, cash = 100) => c.query(`select check_in_visit($1, $2, $3, $4, null, $5, 0, $6, 0, null, null, $7, 'A1', null) r`, [x.t, uuid(), p, x.doc, x.svc, cash, x.admin]).then((r) => r.rows[0].r);
const close = async (c, x, v) => { await c.query(`select move_visit($1, $2, 'with_doctor', null, $3)`, [x.t, v, x.doc]); await c.query(`select move_visit($1, $2, 'done', null, $3)`, [x.t, v, x.doc]); };
const slot = (c, x, p, hoursAhead) => c.query(`insert into appointments (tenant_id, patient_id, doctor_member_id, mode, appointment_date, scheduled_range, source, booked_by_kind, status)
  values ($1, $2, $3, 'slot', ((now() + make_interval(hours => $4)) at time zone 'Asia/Kathmandu')::date, tstzrange(now() + make_interval(hours => $4), now() + make_interval(hours => $4) + interval '15 minutes'), 'desk', 'member', 'confirmed') returning id`,
  [x.t, p, x.doc, hoursAhead]).then((r) => r.rows[0].id);
const merge = (c, x, kept, dup, by = x.admin, reason = "Same person, registered twice") => c.query(`select merge_patients($1, $2, $3, $4, $5) id`, [x.t, kept, dup, by, reason]).then((r) => r.rows[0].id);
const undo = (c, x, m, by = x.admin) => c.query(`select undo_patient_merge($1, $2, $3, 'Merged by mistake') r`, [x.t, m, by]).then((r) => r.rows[0].r);

/** The duplicate's full history: a closed visit with a partly paid bill, a future booking, an allergy, vitals, a signed consultation, an issued prescription. */
async function history(c, x, p) {
  await asApp(c);
  const ci = await checkIn(c, x, p);
  await close(c, x, ci.visit_id);
  await asOwner(c);
  const appt = await slot(c, x, p, 48);
  await c.query(`insert into patient_allergies (tenant_id, patient_id, allergen, recorded_by) values ($1, $2, 'Penicillin', $3)`, [x.t, p, x.admin]);
  await c.query(`insert into vitals (tenant_id, patient_id, recorded_by, pulse) values ($1, $2, $3, 80)`, [x.t, p, x.doc]);
  const { rows: [e] } = await c.query(`insert into encounters (tenant_id, patient_id, doctor_member_id, visit_id, status, finalized_at, chief_complaint) values ($1, $2, $3, $4, 'finalized', now(), 'Fever') returning id`, [x.t, p, x.doc, ci.visit_id]);
  const { rows: [rx] } = await c.query(`insert into prescriptions (tenant_id, patient_id, encounter_id, doctor_member_id, status) values ($1, $2, $3, $4, 'draft') returning id`, [x.t, p, e.id, x.doc]);
  await c.query(`update prescriptions set status = 'issued', rx_number = $2, issued_at = now() where id = $1`, [rx.id, `RX-M${uuid().slice(0, 5)}`]);
  return { visit: ci.visit_id, invoice: ci.invoice_id, appt, encounter: e.id, rx: rx.id };
}
const TABLES = ["visits", "invoices", "payments", "appointments", "patient_allergies", "vitals", "encounters", "prescriptions"];
const counts = async (c, t, p) => Object.fromEntries(await Promise.all(TABLES.map(async (tb) =>
  [tb, (await c.query(`select count(*)::int n from ${tb} where tenant_id = $1 and patient_id = $2`, [t, p])).rows[0].n])));

test("merge: every record moves to the kept patient, the duplicate hides, its MRN still finds them; audited", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const kept = await reg(c, x.t, "Asha Lama", "9841000001");
    const dup = await reg(c, x.t, "Asha K. Lama", "984-100-0001");
    assert.equal(dup.possible_duplicate, true);
    await c.query(`update patients set possible_duplicate = true where id = $1`, [kept.id]);
    const h = await history(c, x, dup.id);
    const before = await counts(c, x.t, dup.id);
    assert.deepEqual(before, { visits: 1, invoices: 1, payments: 1, appointments: 1, patient_allergies: 1, vitals: 1, encounters: 1, prescriptions: 1 });

    await asApp(c);
    await expectError(c, `select merge_patients($1, $2, $3, $4, null)`, [x.t, kept.id, dup.id, x.desk], /NO_PERMISSION/);
    const m = await merge(c, x, kept.id, dup.id);
    await asOwner(c);
    assert.deepEqual(await counts(c, x.t, kept.id), before, "everything is on the kept record");
    assert.deepEqual(Object.values(await counts(c, x.t, dup.id)), TABLES.map(() => 0));
    const { rows: [d] } = await c.query(`select merged_into, deleted_at is not null hidden from patients where id = $1`, [dup.id]);
    assert.deepEqual([d.merged_into, d.hidden], [kept.id, true]);
    assert.equal((await c.query(`select possible_duplicate from patients where id = $1`, [kept.id])).rows[0].possible_duplicate, false, "no likely match left");

    await asApp(c);
    const owed = (await c.query(`select coalesce(sum(outstanding), 0)::numeric n from patient_open_bills($1, $2)`, [x.t, kept.id])).rows[0].n;
    assert.ok(Number(owed) > 0, "the duplicate's unpaid bill is owed by the kept patient");
    assert.deepEqual((await c.query(`select id from search_patients($1, $2)`, [x.t, String(Number(dup.mrn))])).rows.map((r) => r.id), [kept.id], "old MRN finds the kept record");
    assert.equal((await c.query(`select count(*)::int n from search_patients($1, 'Asha')`, [x.t])).rows[0].n, 1, "the duplicate no longer lists");
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 0, 0, null, null, $6, 'A1', null)`, [x.t, uuid(), dup.id, x.doc, x.svc, x.admin], /PATIENT_NOT_FOUND/);
    await expectError(c, `update patients set merged_into = null where id = $1`, [dup.id], /permission denied/);
    await expectError(c, `select merge_patients($1, $2, $3, $4, null)`, [x.t, kept.id, dup.id, x.admin], /PATIENT_NOT_FOUND/);
    await asOwner(c);

    // Locked rows stay locked outside a merge.
    const other = await reg(c, x.t, "Someone Else", null);
    await expectError(c, `update encounters set patient_id = $2 where id = $1`, [h.encounter, other.id], /ENCOUNTER_FINALIZED/);
    await expectError(c, `update prescriptions set patient_id = $2 where id = $1`, [h.rx, other.id], /PRESCRIPTION_LOCKED/);
    await expectError(c, `update vitals set patient_id = $2 where tenant_id = $1 and patient_id = $3`, [x.t, other.id, kept.id], /APPEND_ONLY/);
    await expectError(c, `update encounters set chief_complaint = 'changed', patient_id = $3 where id = $1 and patient_id = $2`, [h.encounter, kept.id, dup.id], /ENCOUNTER_FINALIZED/);

    const { rows: [au] } = await c.query(`select patient_id, reason, detail from audit_log where tenant_id = $1 and action = 'patient.merged'`, [x.t]);
    assert.equal(au.patient_id, kept.id);
    assert.equal(au.reason, "Same person, registered twice");
    assert.equal(au.detail.merge_id, m);
    assert.equal(au.detail.merged_mrn, dup.mrn);
    assert.equal(au.detail.moved.encounters, 1);
  });
});

test("undo: exactly the moved rows go back, newer records stay, the flag returns; only once", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const kept = await reg(c, x.t, "Ram Thapa", "9851000002");
    const dup = await reg(c, x.t, "Ram B Thapa", "9851000002");
    await c.query(`update patients set possible_duplicate = true where id = $1`, [kept.id]);
    await history(c, x, dup.id);
    const keptBefore = await counts(c, x.t, kept.id), dupBefore = await counts(c, x.t, dup.id);
    await asApp(c);
    const m = await merge(c, x, kept.id, dup.id);
    await asOwner(c);
    await c.query(`insert into patient_allergies (tenant_id, patient_id, allergen, recorded_by) values ($1, $2, 'Sulfa', $3)`, [x.t, kept.id, x.admin]);
    await asApp(c);
    await expectError(c, `select undo_patient_merge($1, $2, $3, null)`, [x.t, m, x.desk], /NO_PERMISSION/);
    const r = await undo(c, x, m);
    assert.equal(r.appointments_kept, 0);
    await expectError(c, `select undo_patient_merge($1, $2, $3, null)`, [x.t, m, x.admin], /MERGE_ALREADY_UNDONE/);
    await asOwner(c);
    assert.deepEqual(await counts(c, x.t, dup.id), dupBefore, "the duplicate's records are back");
    assert.deepEqual(await counts(c, x.t, kept.id), { ...keptBefore, patient_allergies: 1 }, "the allergy added after the merge stays");
    const { rows: [d] } = await c.query(`select merged_into, deleted_at from patients where id = $1`, [dup.id]);
    assert.deepEqual([d.merged_into, d.deleted_at], [null, null]);
    assert.equal((await c.query(`select possible_duplicate from patients where id = $1`, [kept.id])).rows[0].possible_duplicate, true);
    assert.equal((await c.query(`select count(*)::int n from audit_log where tenant_id = $1 and action = 'patient.merge_undone' and patient_id = $2`, [x.t, kept.id])).rows[0].n, 1);
    // Merged again after an undo is fine.
    await asApp(c);
    await merge(c, x, kept.id, dup.id);
    await asOwner(c);
  });
});

test("undo: an appointment checked in under the kept record stays with its visit", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const kept = await reg(c, x.t, "Gita Rai", "9800000003"), dup = await reg(c, x.t, "Gita Rai", "9800000003");
    const appt = await slot(c, x, dup.id, 0), later = await slot(c, x, dup.id, 72);   // "now" stays today at any hour
    await asApp(c);
    const m = await merge(c, x, kept.id, dup.id);
    const v = (await c.query(`select check_in_visit($1, $2, $3, $4, $5, $6, 0, 500, 0, null, null, $7, 'A1', null) r`, [x.t, uuid(), kept.id, x.doc, appt, x.svc, x.admin])).rows[0].r.visit_id;
    await close(c, x, v);
    const r = await undo(c, x, m);
    assert.equal(r.appointments_kept, 1);
    await asOwner(c);
    const pat = async (id) => (await c.query(`select patient_id from appointments where id = $1`, [id])).rows[0].patient_id;
    assert.equal(await pat(appt), kept.id);
    assert.equal(await pat(later), dup.id);
  });
});

test("refused: in today's queue, overlapping bookings, same record, a later merge not undone first", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const a = await reg(c, x.t, "Hari Shah", "9811111111"), b = await reg(c, x.t, "Hari Shah", "9811111111"), z = await reg(c, x.t, "Hari P Shah", "9811111111");
    await asApp(c);
    await expectError(c, `select merge_patients($1, $2, $2, $3, null)`, [x.t, a.id, x.admin], /MERGE_SAME_PATIENT/);
    const ci = await checkIn(c, x, b.id);
    await expectError(c, `select merge_patients($1, $2, $3, $4, null)`, [x.t, a.id, b.id, x.admin], /MERGE_LIVE_VISIT/);
    await close(c, x, ci.visit_id);
    await asOwner(c);
    const doc2 = await member(c, x.t, { name: "Dr. Second" });
    await c.query(`insert into doctor_profiles (tenant_id, member_id, consultation_fee) values ($1, $2, 400)`, [x.t, doc2]);
    const ap = await slot(c, x, a.id, 30);
    const bp = (await c.query(`insert into appointments (tenant_id, patient_id, doctor_member_id, mode, appointment_date, scheduled_range, source, booked_by_kind, status)
      select tenant_id, $2, $3, mode, appointment_date, scheduled_range, source, booked_by_kind, 'confirmed' from appointments where id = $1 returning id`, [ap, b.id, doc2])).rows[0].id;
    await asApp(c);
    await expectError(c, `select merge_patients($1, $2, $3, $4, null)`, [x.t, a.id, b.id, x.admin], /MERGE_APPOINTMENT_CLASH/);
    await asOwner(c);
    await c.query(`update appointments set status = 'cancelled', cancelled_at = now(), cancelled_by_kind = 'member' where id = $1`, [bp]);
    await asApp(c);
    const m1 = await merge(c, x, a.id, b.id);
    await merge(c, x, z.id, a.id);
    await expectError(c, `select undo_patient_merge($1, $2, $3, null)`, [x.t, m1, x.admin], /MERGE_UNDO_LATER_FIRST/);
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from visits where patient_id = $1`, [z.id])).rows[0].n, 1, "a chain of merges ends on the last kept record");
  });
});

test("ISOLATION: another clinic can't merge, undo or find these records", async () => {
  await withTx(async (c) => {
    const x = await clinic(c), y = await clinic(c);
    const a = await reg(c, x.t, "Mina Tamang", "9822222222"), b = await reg(c, x.t, "Mina Tamang", "9822222222");
    const ya = await reg(c, y.t, "Mina Tamang", "9822222222");
    await asApp(c);
    await expectError(c, `select merge_patients($1, $2, $3, $4, null)`, [y.t, a.id, b.id, y.admin], /PATIENT_NOT_FOUND/);
    await expectError(c, `select merge_patients($1, $2, $3, $4, null)`, [y.t, ya.id, b.id, y.admin], /PATIENT_NOT_FOUND/);
    await expectError(c, `select merge_patients($1, $2, $3, $4, null)`, [x.t, a.id, b.id, y.admin], /./);
    const m = await merge(c, x, a.id, b.id);
    await expectError(c, `select undo_patient_merge($1, $2, $3, null)`, [y.t, m, y.admin], /MERGE_NOT_FOUND/);
    assert.equal((await c.query(`select count(*)::int n from search_patients($1, $2)`, [y.t, String(Number(b.mrn))])).rows[0].n, 0);
    await asOwner(c);
  });
});
