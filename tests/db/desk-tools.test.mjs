// U4–U5 desk and doctor tools: printing a prescription at the desk, rescheduling, a doctor's own leave, follow-ups. RPCs run as service_role.
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
const day = (n) => new Date(Date.now() + 5.75 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
const at = (n, hm) => `${day(n)}T${hm}:00+05:45`;
const asApp = (c) => c.query(`set role service_role`);
const asOwner = (c) => c.query(`reset role`);
const req = (c, x, start, o = {}) => c.query(
  `select request_booking($1, $2, $3, $4, $5, $6, 30, 'female', 'Fever', $7, $8) id`,
  [x.slug, o.doc ?? x.doc, start, o.name ?? "Asha Lama", o.phone === undefined ? `98${Math.floor(10000000 + Math.random() * 89999999)}` : o.phone, o.email ?? null, o.token ?? `tok-${uuid()}`, o.ip ?? `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`]);

// ── U4 desk tools ──
async function withKeys(c, t, keys) {
  const m = await member(c, t);
  const { rows: [r] } = await c.query(`insert into tenant_roles (tenant_id, name, permissions) values ($1, $2, $3) returning id`, [t, `R-${uuid().slice(0, 6)}`, keys]);
  await c.query(`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [t, m, r.id]);
  return m;
}
async function visitWithRx(c, x, status = "issued") {
  const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'Sita Gurung', 'female', 34) returning id, mrn`, [x.t]);
  const { rows: [v] } = await c.query(`insert into visits (tenant_id, patient_id, doctor_member_id, visit_date, token_no, checked_in_by, idempotency_key) values ($1, $2, $3, $4, (select coalesce(max(token_no), 0) + 1 from visits where tenant_id = $1), $5, $6) returning id`, [x.t, p.id, x.doc, day(0), x.admin, uuid()]);
  const { rows: [e] } = await c.query(`insert into encounters (tenant_id, patient_id, doctor_member_id, visit_id, status, finalized_at, chief_complaint) values ($1, $2, $3, $4, 'finalized', now(), 'Fever for three days') returning id`, [x.t, p.id, x.doc, v.id]);
  const { rows: [rx] } = await c.query(`insert into prescriptions (tenant_id, patient_id, encounter_id, doctor_member_id, status, notes) values ($1, $2, $3, $4, 'draft', 'Plenty of fluids') returning id`, [x.t, p.id, e.id, x.doc]);
  await c.query(`insert into prescription_items (tenant_id, prescription_id, line_no, medicine_text, dose, frequency, duration_days, quantity) values ($1, $2, 1, 'Paracetamol 500', '1 tab', '1-1-1', 3, 9)`, [x.t, rx.id]);
  if (status === "issued") await c.query(`update prescriptions set status = 'issued', rx_number = 'RX-D0001', issued_at = now() where id = $1`, [rx.id]);
  return { patient: p, visit: v.id, rx: rx.id };
}

test("print an issued prescription: only with print_prescriptions, audited, never the diagnosis or notes", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const reg = await withKeys(c, x.t, ["print_prescriptions", "view_queue"]);
    const r = await visitWithRx(c, x);
    await asApp(c);
    assert.equal((await c.query(`select print_prescription($1, $2, $3, 'A1') j`, [x.t, x.desk, r.rx])).rows[0].j.error, "NO_PERMISSION");
    assert.equal((await c.query(`select count(*)::int n from visit_prescriptions($1, $2, $3)`, [x.t, x.desk, day(0)])).rows[0].n, 0, "no key: not even which visits have one");
    const vp = (await c.query(`select visit_id, rx_number from visit_prescriptions($1, $2, $3)`, [x.t, reg, day(0)])).rows;
    assert.deepEqual(vp.map((v) => [v.visit_id, v.rx_number]), [[r.visit, "RX-D0001"]]);
    const j = (await c.query(`select print_prescription($1, $2, $3, 'A1') j`, [x.t, reg, r.rx])).rows[0].j;
    assert.equal(j.rx_number, "RX-D0001");
    assert.equal(j.items[0].medicine_text, "Paracetamol 500");
    assert.equal(j.notes, "Plenty of fluids", "the doctor's advice is on the paper");
    assert.match(j.doctor.registration, /^NMC R-/, "the doctor's verified registration");
    assert.equal(j.patient.mrn, r.patient.mrn);
    assert.ok(!JSON.stringify(j).includes("Fever"), "never the complaint or diagnosis");
    await asOwner(c);
    const au = (await c.query(`select outcome, patient_id from audit_log where tenant_id = $1 and action = 'prescription.print' order by id`, [x.t])).rows;
    assert.deepEqual(au.map((a) => a.outcome), ["denied", "success"]);
    assert.equal(au[1].patient_id, r.patient.id);
    const draft = await visitWithRx(c, x, "draft");
    await asApp(c);
    assert.equal((await c.query(`select print_prescription($1, $2, $3, 'A1') j`, [x.t, reg, draft.rx])).rows[0].j.error, "NOT_FOUND", "a draft can't be printed");
    await asOwner(c);
  });
});

test("reschedule: one transaction, the new one points back, one 'rescheduled' email; a taken slot changes nothing", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years, email) values ($1, 'Asha Lama', 'female', 30, 'asha@example.com') returning id`, [x.t]);
    const { rows: [q] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'Ram Thapa', 'male', 40) returning id`, [x.t]);
    await asApp(c);
    const { rows: [{ id: a1 }] } = await req(c, x, at(2, "09:00"), { token: "s-1" });
    await c.query(`select approve_booking_request($1, $2, $3, $4)`, [x.t, a1, p.id, x.desk]);
    const { rows: [{ id: a2 }] } = await req(c, x, at(2, "10:00"), { token: "s-2" });
    await c.query(`select approve_booking_request($1, $2, $3, $4)`, [x.t, a2, q.id, x.desk]);
    await expectError(c, `select reschedule_appointment($1, $2, $3, null, $4)`, [x.t, a1, at(2, "11:00"), x.desk], /NO_PERMISSION/);
    await expectError(c, `select reschedule_appointment($1, $2, $3, null, $4)`, [x.t, a1, at(2, "10:00"), x.admin], /SLOT|taken|exclu|overlap/i);
    await asOwner(c);
    assert.equal((await c.query(`select status from appointments where id = $1`, [a1])).rows[0].status, "confirmed", "a taken slot leaves the old booking as it was");
    await asApp(c);
    const n = (await c.query(`select reschedule_appointment($1, $2, $3, null, $4) id`, [x.t, a1, at(3, "11:00"), x.admin])).rows[0].id;
    await asOwner(c);
    const { rows: [old] } = await c.query(`select status, cancel_reason from appointments where id = $1`, [a1]);
    const { rows: [nw] } = await c.query(`select status, rescheduled_from_id, patient_id from appointments where id = $1`, [n]);
    assert.equal(old.status, "cancelled");
    assert.match(old.cancel_reason, /^Rescheduled to /);
    assert.deepEqual([nw.status, nw.rescheduled_from_id, nw.patient_id], ["confirmed", a1, p.id]);
    const mail = (await c.query(`select ref_id, kind, status from notification_outbox where tenant_id = $1 and channel = 'email' and ref_id = any($2) order by id`, [x.t, [a1, n]])).rows;
    const pending = mail.filter((m) => m.status === "pending").map((m) => [m.ref_id, m.kind]);
    assert.deepEqual(pending, [[n, "booking_rescheduled"], [n, "booking_reminder"]], "only 'rescheduled' and the new reminder go out");
    await asApp(c);
    await expectError(c, `select reschedule_appointment($1, $2, $3, null, $4)`, [x.t, a1, at(3, "12:00"), x.admin], /NOT_RESCHEDULABLE/);
    await asOwner(c);
  });
});

// ── U5 doctor's own leave and follow-ups ──
async function doctorKeys(c, x) {
  const { rows: [r] } = await c.query(`insert into tenant_roles (tenant_id, name, permissions) values ($1, 'Doctor test', array['manage_own_leave', 'write_consultation', 'view_schedules']) returning id`, [x.t]);
  await c.query(`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [x.t, x.doc, r.id]);
}

test("own leave: whole days over a range, desk told about bookings hit, bookings listed and never cancelled, times vanish", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await doctorKeys(c, x);
    const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'Asha Lama', 'female', 30) returning id`, [x.t]);
    await asApp(c);
    const { rows: [{ id: a1 }] } = await req(c, x, at(2, "09:00"), { token: "l-1" });
    await c.query(`select approve_booking_request($1, $2, $3, $4)`, [x.t, a1, p.id, x.desk]);
    await expectError(c, `select add_own_leave($1, $2, $3, $4, null, null, 'x')`, [x.t, x.desk, day(2), day(3)], /NO_PERMISSION/);
    await expectError(c, `select add_own_leave($1, $2, $3, $4, '09:00', '10:00', 'x')`, [x.t, x.doc, day(2), day(3)], /BAD_TIMES/);
    await expectError(c, `select add_own_leave($1, $2, $3, $4, null, null, 'x')`, [x.t, x.doc, day(2), day(80)], /TOO_LONG/);
    await expectError(c, `select add_own_leave($1, $2, $3, $4, null, null, 'x')`, [x.t, x.doc, day(-1), day(1)], /BAD_DATES/);
    const r = (await c.query(`select add_own_leave($1, $2, $3, $4, null, null, 'Family wedding') r`, [x.t, x.doc, day(2), day(3)])).rows[0].r;
    assert.deepEqual([r.days, r.appointments], [2, 1]);
    assert.equal((await c.query(`select add_own_leave($1, $2, $3, $4, null, null, null) r`, [x.t, x.doc, day(2), day(3)])).rows[0].r.days, 0, "days already on leave are skipped");
    const onLeave = (await c.query(`select appointment_id, patient from appointments_on_leave($1, 30)`, [x.t])).rows;
    assert.deepEqual(onLeave.map((o) => [o.appointment_id, o.patient]), [[a1, "Asha Lama"]]);
    assert.equal((await c.query(`select count(*)::int n from available_slots($1, $2, $3, $3)`, [x.t, x.doc, day(2)])).rows[0].n, 0, "no free times on a leave day");
    await asOwner(c);
    assert.equal((await c.query(`select status from appointments where id = $1`, [a1])).rows[0].status, "confirmed", "never cancelled automatically");
    const n = (await c.query(`select kind, title, body, link from notifications where member_id = $1 and kind = 'doctor_leave'`, [x.admin])).rows;
    assert.equal(n.length, 1, "one notice, for the day that had a booking");
    assert.match(n[0].body, /1 appointment needs moving/);
    assert.ok(!/wedding/i.test(n[0].body), "the doctor's reason isn't broadcast");
    const { rows: [ex] } = await c.query(`select id from schedule_exceptions where member_id = $1 order by on_date limit 1`, [x.doc]);
    await asApp(c);
    await expectError(c, `select remove_own_leave($1, $2, $3)`, [x.t, x.admin, ex.id], /NO_PERMISSION|NOT_FOUND/);
    await c.query(`select remove_own_leave($1, $2, $3)`, [x.t, x.doc, ex.id]);
    assert.equal((await c.query(`select count(*)::int n from appointments_on_leave($1, 30)`, [x.t])).rows[0].n, 0, "leave removed: nothing to move");
    await asOwner(c);
  });
});

test("follow-up: a doctor books their own diary for a patient they have seen; slot rules apply", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await doctorKeys(c, x);
    const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years, email) values ($1, 'Asha Lama', 'female', 30, 'asha@example.com') returning id`, [x.t]);
    const { rows: [q] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'Ram Thapa', 'male', 40) returning id`, [x.t]);
    await c.query(`insert into encounters (tenant_id, patient_id, doctor_member_id, status, finalized_at) values ($1, $2, $3, 'finalized', now())`, [x.t, p.id, x.doc]);
    await asApp(c);
    await expectError(c, `select book_follow_up($1, $2, $3, $4)`, [x.t, x.desk, p.id, at(4, "09:30")], /NO_PERMISSION/);
    await expectError(c, `select book_follow_up($1, $2, $3, $4)`, [x.t, x.doc, q.id, at(4, "09:30")], /NOT_YOUR_PATIENT/);
    await expectError(c, `select book_follow_up($1, $2, $3, now() - interval '1 hour')`, [x.t, x.doc, p.id], /IN_THE_PAST/);
    const id = (await c.query(`select book_follow_up($1, $2, $3, $4) id`, [x.t, x.doc, p.id, at(4, "09:30")])).rows[0].id;
    await expectError(c, `select book_follow_up($1, $2, $3, $4)`, [x.t, x.doc, p.id, at(4, "09:30")], /taken|exclu|overlap|SLOT/i);
    await asOwner(c);
    const { rows: [a] } = await c.query(`select source, status, doctor_member_id from appointments where id = $1`, [id]);
    assert.deepEqual([a.source, a.status, a.doctor_member_id], ["follow_up", "confirmed", x.doc]);
    assert.equal((await c.query(`select count(*)::int n from notification_outbox where ref_id = $1::text and kind = 'booking_confirmed'`, [id])).rows[0].n, 1, "the patient is told");
  });
});
