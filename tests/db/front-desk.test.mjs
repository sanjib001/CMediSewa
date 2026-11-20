// B4a front desk: patients (MRN, duplicates), booking (no double booking, token capacity,
// rules), check-in with the OPD fee posted to the journal, the queue, idempotency, and a real
// two-connection booking race. The app's role (service_role) is used for every RPC call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";
import { loadTarget, client } from "../../scripts/lib/db.mjs";

async function authUser(c) {
  const id = uuid();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
    [id, `fd-${id.slice(0, 8)}@example.invalid`]);
  return id;
}
async function member(c, t, name = "Desk Person") {
  const { rows: [m] } = await c.query(`insert into tenant_members (tenant_id, auth_user_id, display_name, email) values ($1, $2, $3, $4) returning id`,
    [t, await authUser(c), name, `m-${uuid().slice(0, 8)}@example.invalid`]);
  return m.id;
}
async function doctor(c, t, fee = 500) {
  const d = await member(c, t, "Dr. Desk Test");
  await c.query(`insert into doctor_profiles (tenant_id, member_id, consultation_fee) values ($1, $2, $3)`, [t, d, fee]);
  // Every day: 09:00–12:00 in 15-minute slots, and a 15:00–17:00 token session of 2.
  await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes, effective_from)
                 select $1, $2, w, '09:00', '12:00', 15, current_date - 1 from generate_series(0, 6) w`, [t, d]);
  await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, max_tokens, effective_from)
                 select $1, $2, w, '15:00', '17:00', 2, current_date - 1 from generate_series(0, 6) w`, [t, d]);
  return d;
}
/** An active clinic with settings, a default billing profile, a desk member, a doctor and an OPD service. */
async function clinic(c, { status = "active" } = {}) {
  const t = await makeTenant(c);
  await c.query(`update tenants set status = $2 where id = $1`, [t, status]);
  const { rows: [bp] } = await c.query(`insert into billing_profiles (tenant_id, name, legal_name, invoice_prefix, is_default) values ($1, 'Clinic', 'Test Clinic', 'T', true) returning id`, [t]);
  await c.query(`insert into tenant_settings (tenant_id, default_billing_profile_id) values ($1, $2)`, [t, bp.id]);
  const desk = await member(c, t);
  const doc = await doctor(c, t);
  const { rows: [svc] } = await c.query(`insert into services (tenant_id, name, kind, price_npr) values ($1, 'General OPD', 'consultation', 300) returning id`, [t]);
  return { t, desk, doc, svc: svc.id, bp: bp.id };
}
async function patient(c, t, name = "Ram Bahadur Thapa", phone = "9841000000", extra = {}) {
  const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years, phone, date_of_birth) values ($1, $2, 'male', 40, $3, $4) returning id, mrn, possible_duplicate`,
    [t, name, phone, extra.dob ?? null]);
  return p;
}
// Kathmandu-local timestamps for a day N days ahead.
const ktm = (daysAhead, hhmm) => {
  const d = new Date(Date.now() + 5.75 * 3600_000 + daysAhead * 86_400_000).toISOString().slice(0, 10);
  return `${d}T${hhmm}:00+05:45`;
};
const asApp = (c) => c.query(`set role service_role`);
const asOwner = (c) => c.query(`reset role`);
const book = (c, x, p, start, kind = "member", by = x.desk) =>
  c.query(`select book_appointment($1, $2, $3, $4, $5, 'desk', null, $6, $7, null) id`, [x.t, p, x.doc, start, x.svc, kind, by]);
const checkIn = (c, x, p, o = {}) => c.query(
  `select check_in_visit($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null, $11, 'A1', null) r`,
  [x.t, o.key ?? uuid(), p, x.doc, o.appointment ?? null, o.service === undefined ? x.svc : o.service, o.discount ?? 0, o.cash ?? 500, o.online ?? 0, o.channel ?? null, x.desk]);

test("patients: MRN per clinic, never changes; duplicates flagged; search", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const a = await patient(c, x.t);
    const b = await patient(c, x.t, "Sita Sharma", "9851111111");
    assert.equal(a.mrn, "000001");
    assert.equal(b.mrn, "000002");
    assert.equal(a.possible_duplicate, false);
    const dup = await patient(c, x.t, "Ram B. Thapa", "984-1000000");
    assert.equal(dup.possible_duplicate, true, "same phone + first name");
    const other = await clinic(c);
    assert.equal((await patient(c, other.t)).mrn, "000001", "each clinic has its own MRN series");
    await expectError(c, `update patients set mrn = '999999' where id = $1`, [a.id], /MRN_IMMUTABLE/);
    await asApp(c);
    await expectError(c, `update patients set mrn = '999999' where id = $1`, [a.id], /permission denied/);
    const find = async (q) => (await c.query(`select mrn from search_patients($1, $2)`, [x.t, q])).rows.map((r) => r.mrn);
    assert.deepEqual(await find("2"), ["000002"], "by MRN");
    assert.deepEqual((await find("1111")).sort(), ["000002"], "by phone digits");
    assert.deepEqual((await find("thapa")).sort(), ["000001", "000003"], "by name");
    assert.deepEqual(await find("Ram Bahadur Thapa"), ["000001"]);
    const theirs = (await c.query(`select tenant_id from search_patients($1, 'thapa')`, [other.t])).rows;
    assert.ok(theirs.length === 1 && theirs.every((r) => r.tenant_id === other.t), "another clinic sees only its own patients");
    await asOwner(c);
  });
});

test("booking: offered slots only, no double booking, token capacity, notice and status rules", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const p1 = (await patient(c, x.t)).id, p2 = (await patient(c, x.t, "Sita Sharma", "9851111111")).id, p3 = (await patient(c, x.t, "Hari KC", "9861111111")).id;
    await asApp(c);
    const { rows: [{ id: a1 }] } = await book(c, x, p1, ktm(2, "09:15"));
    assert.equal((await c.query(`select status, mode from appointments where id = $1`, [a1])).rows[0].status, "confirmed");
    await expectError(c, `select book_appointment($1, $2, $3, $4, null, 'desk', null, 'member', $5, null)`, [x.t, p2, x.doc, ktm(2, "09:15"), x.desk], /SLOT_TAKEN/);
    await expectError(c, `select book_appointment($1, $2, $3, $4, null, 'desk', null, 'member', $5, null)`, [x.t, p2, x.doc, ktm(2, "09:07"), x.desk], /SLOT_UNAVAILABLE/);
    await expectError(c, `select book_appointment($1, $2, $3, $4, null, 'desk', null, 'member', $5, null)`, [x.t, p2, x.doc, ktm(-1, "09:15"), x.desk], /SLOT_IN_PAST|SLOT_UNAVAILABLE/);
    await expectError(c, `select book_appointment($1, $2, $3, $4, null, 'desk', null, 'member', $5, null)`, [x.t, p2, x.doc, ktm(45, "09:15"), x.desk], /BEYOND_BOOKING_WINDOW/);
    // token session: capacity 2
    await book(c, x, p1, ktm(2, "15:00"));
    await book(c, x, p2, ktm(2, "15:00"));
    await expectError(c, `select book_appointment($1, $2, $3, $4, null, 'desk', null, 'member', $5, null)`, [x.t, p3, x.doc, ktm(2, "15:00"), x.desk], /SESSION_FULL/);
    // a patient can't hold two overlapping bookings (here: a second doctor, same time)
    await asOwner(c);
    const doc2 = await doctor(c, x.t);
    await asApp(c);
    await expectError(c, `select book_appointment($1, $2, $3, $4, null, 'desk', null, 'member', $5, null)`, [x.t, p1, doc2, ktm(2, "09:15"), x.desk], /PATIENT_ALREADY_BOOKED/);
    // online bookings respect the notice period; staff bookings don't
    await asOwner(c);
    await c.query(`update tenant_settings set min_notice_minutes = 10080 where tenant_id = $1`, [x.t]);
    await asApp(c);
    await expectError(c, `select book_appointment($1, $2, $3, $4, null, 'online', null, 'guest', null, 'h1')`, [x.t, p3, x.doc, ktm(2, "10:00")], /TOO_SHORT_NOTICE/);
    // cancel needs a reason, frees the slot, and can't be undone
    await expectError(c, `select set_appointment_status($1, $2, 'cancelled', '', 'member', $3)`, [x.t, a1, x.desk], /REASON_REQUIRED/);
    await c.query(`select set_appointment_status($1, $2, 'cancelled', 'Patient called', 'member', $3)`, [x.t, a1, x.desk]);
    await book(c, x, p2, ktm(2, "09:15"));
    await expectError(c, `select set_appointment_status($1, $2, 'confirmed', null, 'member', $3)`, [x.t, a1, x.desk], /ILLEGAL_TRANSITION/);
    await expectError(c, `insert into appointments (tenant_id, patient_id, doctor_member_id, mode, appointment_date, scheduled_range, source, booked_by_kind) values ($1, $2, $3, 'slot', current_date, tstzrange(now(), now() + interval '1 hour'), 'desk', 'member')`, [x.t, p3, x.doc], /permission denied/);
    await asOwner(c);
  });
});

test("check-in: token + OPD fee bill + payment, balanced journal, one transaction", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const p1 = (await patient(c, x.t)).id, p2 = (await patient(c, x.t, "Sita Sharma", "9851111111")).id;
    await asApp(c);
    const key = uuid();
    const r1 = (await checkIn(c, x, p1, { key })).rows[0].r;
    assert.equal(r1.token_no, 1);
    assert.equal(r1.invoice_no, "T-00001");
    assert.equal(Number(r1.total), 500, "a consultation uses the doctor's fee");
    assert.equal(Number(r1.paid), 500);
    const again = (await checkIn(c, x, p1, { key })).rows[0].r;
    assert.equal(again.replayed, true, "a retry returns the first result");
    assert.equal(again.visit_id, r1.visit_id);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 500, 0, null, null, $6, 'A1', null)`, [x.t, uuid(), p1, x.doc, x.svc, x.desk], /ALREADY_CHECKED_IN/);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 200, 0, null, null, $6, 'A1', null)`, [x.t, uuid(), p2, x.doc, x.svc, x.desk], /PAYMENT_REQUIRED/);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 600, 0, null, null, $6, 'A1', null)`, [x.t, uuid(), p2, x.doc, x.svc, x.desk], /OVERPAYMENT/);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 100, 400, 0, null, null, $6, 'A1', null)`, [x.t, uuid(), p2, x.doc, x.svc, x.desk], /DISCOUNT_NEEDS_APPROVAL/);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 200, 300, null, null, $6, 'A1', null)`, [x.t, uuid(), p2, x.doc, x.svc, x.desk], /CHANNEL_REQUIRED/);
    const r2 = (await checkIn(c, x, p2, { cash: 200, online: 250, discount: 50, channel: "esewa" })).rows[0].r;
    assert.equal(r2.token_no, 2, "failed attempts don't use up tokens");
    assert.equal(r2.invoice_no, "T-00002", "bill numbers have no gaps");
    assert.equal(Number(r2.total), 450);

    await asOwner(c);
    const { rows: j } = await c.query(`select account_code a, sum(debit)::numeric dr, sum(credit)::numeric cr from ledger_entries where tenant_id = $1 group by 1 order by 1`, [x.t]);
    const acct = Object.fromEntries(j.map((r) => [r.a, Number(r.dr) - Number(r.cr)]));
    assert.deepEqual(acct, { AR_PATIENTS: 0, BANK: 250, CASH: 700, REV_SERVICES: -950 }, "cash 700 + bank 250 = revenue 950, nothing owed");
    const { rows: [pay] } = await c.query(`select cash_amount, online_amount, online_channel from payments where tenant_id = $1 and online_amount > 0`, [x.t]);
    assert.deepEqual([Number(pay.cash_amount), Number(pay.online_amount), pay.online_channel], [200, 250, "esewa"]);
    assert.equal((await c.query(`select count(*)::int n from invoices where tenant_id = $1`, [x.t])).rows[0].n, 2);

    // credit (due) only when the clinic allows it, within the limit
    await c.query(`update tenant_settings set allow_credit = true, credit_limit_per_patient = 1000 where tenant_id = $1`, [x.t]);
    const doc2 = await doctor(c, x.t, 800);
    await asApp(c);
    const r3 = (await c.query(`select check_in_visit($1, $2, $3, $4, null, $5, 0, 0, 0, null, null, $6, 'A1', null) r`, [x.t, uuid(), p1, doc2, x.svc, x.desk])).rows[0].r;
    assert.equal(Number(r3.due), 800);
    await asOwner(c);
    const doc3 = await doctor(c, x.t, 300);
    await asApp(c);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 0, 0, null, null, $6, 'A1', null)`, [x.t, uuid(), p1, doc3, x.svc, x.desk], /CREDIT_LIMIT/);
    await expectError(c, `insert into invoices (tenant_id, billing_profile_id, invoice_no, fiscal_year, source, subtotal, total, issued_by, posting_id) values ($1, $2, 'X', '2083/84', 'counter', 1, 1, $3, $4)`, [x.t, x.bp, x.desk, uuid()], /permission denied/);
    await asOwner(c);
  });
});

test("queue: appointment check-in → called → done; checkout billing; cancel; inactive clinic", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const p1 = (await patient(c, x.t)).id, p2 = (await patient(c, x.t, "Sita Sharma", "9851111111")).id;
    const { rows: [a] } = await c.query(`insert into appointments (tenant_id, patient_id, doctor_member_id, mode, appointment_date, scheduled_range, source, booked_by_kind, status)
      values ($1, $2, $3, 'slot', (now() at time zone 'Asia/Kathmandu')::date, tstzrange(now() + interval '1 hour', now() + interval '75 minutes'), 'desk', 'member', 'confirmed') returning id`, [x.t, p1, x.doc]);
    await asApp(c);
    const v = (await checkIn(c, x, p1, { appointment: a.id })).rows[0].r.visit_id;
    const st = async () => (await c.query(`select (select status from visits where id = $1) v, (select status from appointments where id = $2) a`, [v, a.id])).rows[0];
    assert.deepEqual(await st(), { v: "waiting", a: "checked_in" });
    await expectError(c, `select move_visit($1, $2, 'done', null, $3)`, [x.t, v, x.desk], /ILLEGAL_TRANSITION/);
    await c.query(`select move_visit($1, $2, 'with_doctor', null, $3)`, [x.t, v, x.doc]);
    assert.deepEqual(await st(), { v: "with_doctor", a: "in_consultation" });
    await c.query(`select move_visit($1, $2, 'done', null, $3)`, [x.t, v, x.doc]);
    assert.deepEqual(await st(), { v: "closed", a: "completed" });

    await asOwner(c);
    await c.query(`update tenant_settings set consultation_billing_point = 'checkout' where tenant_id = $1`, [x.t]);
    await asApp(c);
    const r2 = (await checkIn(c, x, p2, { cash: 0 })).rows[0].r;
    assert.equal(r2.invoice_id, null, "no bill at registration when the clinic bills at checkout");
    await expectError(c, `select move_visit($1, $2, 'cancelled', '', $3)`, [x.t, r2.visit_id, x.desk], /REASON_REQUIRED/);
    await c.query(`select move_visit($1, $2, 'with_doctor', null, $3)`, [x.t, r2.visit_id, x.doc]);
    await c.query(`select move_visit($1, $2, 'done', null, $3)`, [x.t, r2.visit_id, x.doc]);
    assert.equal((await c.query(`select status from visits where id = $1`, [r2.visit_id])).rows[0].status, "awaiting_billing");

    await asOwner(c);
    const y = await clinic(c, { status: "pending" });
    const py = (await patient(c, y.t)).id;
    await asApp(c);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 500, 0, null, null, $6, 'A1', null)`, [y.t, uuid(), py, y.doc, y.svc, y.desk], /TENANT_NOT_ACTIVE/);
    await asOwner(c);
  });
});

test("ISOLATION: one clinic can't book, check in or move another clinic's people", async () => {
  await withTx(async (c) => {
    const a = await clinic(c), b = await clinic(c);
    const pb = (await patient(c, b.t)).id;
    const pa = (await patient(c, a.t)).id;
    await asApp(c);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 500, 0, null, null, $6, 'A1', null)`, [a.t, uuid(), pb, a.doc, a.svc, a.desk], /PATIENT_NOT_FOUND/);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 500, 0, null, null, $6, 'A1', null)`, [a.t, uuid(), pa, b.doc, a.svc, a.desk], /DOCTOR_NOT_FOUND/);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 500, 0, null, null, $6, 'A1', null)`, [a.t, uuid(), pa, a.doc, b.svc, a.desk], /SERVICE_NOT_FOUND/);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 500, 0, null, null, $6, 'A1', null)`, [a.t, uuid(), pa, a.doc, a.svc, b.desk], /MEMBER_NOT_FOUND/);
    await expectError(c, `select book_appointment($1, $2, $3, $4, null, 'desk', null, 'member', $5, null)`, [a.t, pb, a.doc, ktm(2, "09:15"), a.desk], /PATIENT_NOT_FOUND/);
    await expectError(c, `select book_appointment($1, $2, $3, $4, null, 'desk', null, 'member', $5, null)`, [a.t, pa, b.doc, ktm(2, "09:15"), a.desk], /SLOT_UNAVAILABLE/);
    const vb = (await checkIn(c, b, pb)).rows[0].r.visit_id;
    await expectError(c, `select move_visit($1, $2, 'with_doctor', null, $3)`, [a.t, vb, a.desk], /VISIT_NOT_FOUND/);
    await asOwner(c);
  });
});

test("RACE: two desks booking the same slot at the same moment; exactly one wins", async () => {
  const target = loadTarget(process.env.CMEDISEWA_TEST_ENV ?? ".env.local");
  const setup = client(target), c1 = client(target), c2 = client(target);
  await Promise.all([setup.connect(), c1.connect(), c2.connect()]);
  let x;
  try {
    // Committed fixture (the other connection must see it); closed afterwards.
    await setup.query("begin");
    x = await clinic(setup);
    await setup.query(`update tenants set name = 'DB race test (safe to ignore)' where id = $1`, [x.t]);
    const p1 = (await patient(setup, x.t)).id, p2 = (await patient(setup, x.t, "Sita Sharma", "9851111111")).id;
    await setup.query("commit");
    const start = ktm(3, "10:30");
    await c1.query("begin"); await c2.query("begin");
    await c1.query("set role service_role"); await c2.query("set role service_role");
    await book(c1, x, p1, start);                                   // holds the slot, not committed yet
    const second = book(c2, x, p2, start).then(() => "won", (e) => e.message); // waits on c1
    await new Promise((r) => setTimeout(r, 300));
    await c1.query("commit");
    assert.match(await second, /SLOT_TAKEN/);
    await c2.query("rollback");
    const { rows: [{ n }] } = await setup.query(`select count(*)::int n from appointments where tenant_id = $1 and status = 'confirmed'`, [x.t]);
    assert.equal(n, 1);
  } finally {
    if (x) await setup.query(`update tenants set status = 'closed' where id = $1`, [x.t]).catch(() => {});
    await Promise.all([setup.end(), c1.end(), c2.end()]);
  }
});

test("slots never run past the window end, even near midnight; a patient can be sent back to the queue", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await c.query(`delete from doctor_schedules where member_id = $1`, [x.doc]);
    await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes, effective_from)
                   select $1, $2, w, '22:00', '23:45', 15, current_date - 1 from generate_series(0, 6) w`, [x.t, x.doc]);
    const day = ktm(2, "00:00").slice(0, 10);
    const { rows } = await c.query(`select slot_end from available_slots($1, $2, $3, $3) order by 1`, [x.t, x.doc, day]);
    assert.equal(rows.length, 7, "22:00–23:45 in 15-minute slots");
    assert.equal(rows.at(-1).slot_end.toISOString(), new Date(`${day}T23:45:00+05:45`).toISOString());
    const p = (await patient(c, x.t)).id;
    const { rows: [a] } = await c.query(`insert into appointments (tenant_id, patient_id, doctor_member_id, mode, appointment_date, scheduled_range, source, booked_by_kind, status)
      values ($1, $2, $3, 'slot', (now() at time zone 'Asia/Kathmandu')::date, tstzrange(now() + interval '1 hour', now() + interval '75 minutes'), 'desk', 'member', 'confirmed') returning id`, [x.t, p, x.doc]);
    await asApp(c);
    const v = (await checkIn(c, x, p, { appointment: a.id })).rows[0].r.visit_id;
    await c.query(`select move_visit($1, $2, 'with_doctor', null, $3)`, [x.t, v, x.doc]);
    await c.query(`select move_visit($1, $2, 'waiting', null, $3)`, [x.t, v, x.doc]);
    assert.equal((await c.query(`select status from appointments where id = $1`, [a.id])).rows[0].status, "checked_in");
    await asOwner(c);
  });
});
