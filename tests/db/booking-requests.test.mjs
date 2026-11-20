// B4c website booking REQUESTS (D-82): public slots, request limits, hold the time, status
// link + cancel, staff approve (link a patient) or decline, expiry, isolation.
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
const slots = async (c, x, d) => (await c.query(`select slot_start, mode, places_left from public_booking_slots($1, $2, $3)`, [x.slug, x.doc, d])).rows;

test("public slots: only live clinics taking requests and verified public doctors; held times disappear", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const u = await clinic(c, { verified: false });
    await asApp(c);
    const s = await slots(c, x, day(2));
    assert.equal(s.filter((r) => r.mode === "slot").length, 12);
    assert.equal(s.find((r) => r.mode === "token").places_left, 2);
    assert.equal((await slots(c, u, day(2))).length, 0, "doctor with an unverified registration isn't bookable");
    await req(c, x, at(2, "09:15"));
    assert.ok(!(await slots(c, x, day(2))).some((r) => r.slot_start.toISOString() === new Date(at(2, "09:15")).toISOString()), "a requested time is held");
    await req(c, x, at(2, "15:00"));
    assert.equal((await slots(c, x, day(2))).find((r) => r.mode === "token").places_left, 1, "a token place is held");
    await asOwner(c);
    await c.query(`update site_settings set booking_enabled = false where tenant_id = $1`, [x.t]);
    await asApp(c);
    assert.equal((await slots(c, x, day(2))).length, 0, "booking switched off");
    await expectError(c, `select request_booking($1, $2, $3, 'Someone', '9800000001', null, 30, 'male', null, 'tk', null)`, [x.slug, x.doc, at(2, "10:00")], /BOOKING_CLOSED/);
    await asOwner(c);
  });
});

test("requests: always 'requested', no patient record, one per slot, contact required, limits", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    const { rows: [{ id }] } = await req(c, x, at(2, "09:30"), { phone: "9841000001" });
    await asOwner(c);
    const { rows: [a] } = await c.query(`select status, patient_id, source, requester_name from appointments where id = $1`, [id]);
    assert.deepEqual([a.status, a.patient_id, a.source, a.requester_name], ["requested", null, "online", "Asha Lama"]);
    assert.equal((await c.query(`select count(*)::int n from patients where tenant_id = $1`, [x.t])).rows[0].n, 0, "no patient record from a request");
    await c.query(`update tenant_settings set auto_confirm_online = true where tenant_id = $1`, [x.t]);
    await asApp(c);
    const { rows: [{ id: id2 }] } = await req(c, x, at(2, "09:45"), { phone: "9841000001" });
    await asOwner(c);
    assert.equal((await c.query(`select status from appointments where id = $1`, [id2])).rows[0].status, "requested", "never auto-confirmed (D-82)");
    await asApp(c);
    await expectError(c, `select request_booking($1, $2, $3, 'Other', '9800000002', null, 30, 'male', null, 'tk2', null)`, [x.slug, x.doc, at(2, "09:30")], /SLOT_UNAVAILABLE|SLOT_TAKEN/);
    await expectError(c, `select request_booking($1, $2, $3, 'No Contact', '', '', 30, 'male', null, 'tk3', null)`, [x.slug, x.doc, at(2, "10:00")], /CONTACT_REQUIRED/);
    await expectError(c, `select request_booking($1, $2, $3, 'Asha Lama', '984-1000001', null, 30, 'female', null, 'tk4', null)`, [x.slug, x.doc, at(3, "10:00")], /TOO_MANY_OPEN/);
    for (let i = 0; i < 5; i++) await req(c, x, at(4, ["09:00", "09:15", "09:30", "09:45", "10:00"][i]), { ip: "10.9.9.9" });
    await expectError(c, `select request_booking($1, $2, $3, 'Spammer', '9800000099', null, 30, 'male', null, 'tk5', '10.9.9.9')`, [x.slug, x.doc, at(4, "11:00")], /RATE_LIMITED/);
    await asOwner(c);
  });
});

test("status link, cancel by the requester, approve (link patient) or decline, expiry", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    await req(c, x, at(2, "09:00"), { token: "link-1", name: "Raju Thapa" });
    let s = (await c.query(`select public_booking_status($1, 'link-1') j`, [x.slug])).rows[0].j;
    assert.equal(s.status, "requested");
    assert.equal(s.name, "Raju Thapa");
    assert.equal((await c.query(`select public_booking_status($1, 'link-1') j`, ["some-other-clinic"])).rows[0].j, null, "a link only works on its own clinic");
    await c.query(`select cancel_booking_by_token($1, 'link-1', 'Feeling better')`, [x.slug]);
    s = (await c.query(`select public_booking_status($1, 'link-1') j`, [x.slug])).rows[0].j;
    assert.equal(s.status, "cancelled");
    assert.ok((await slots(c, x, day(2))).some((r) => r.slot_start.toISOString() === new Date(at(2, "09:00")).toISOString()), "the time is free again");
    await expectError(c, `select cancel_booking_by_token($1, 'link-1', null)`, [x.slug], /TOO_LATE_TO_CANCEL/);

    const { rows: [{ id: r2 }] } = await req(c, x, at(2, "10:00"), { token: "link-2" });
    await asOwner(c);
    const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years, phone) values ($1, 'Asha Lama', 'female', 30, '9841000002') returning id`, [x.t]);
    await asApp(c);
    await expectError(c, `select set_appointment_status($1, $2, 'confirmed', null, 'member', $3)`, [x.t, r2, x.desk], /appointments_patient_required/);
    await c.query(`select approve_booking_request($1, $2, $3, $4)`, [x.t, r2, p.id, x.desk]);
    assert.equal((await c.query(`select public_booking_status($1, 'link-2') j`, [x.slug])).rows[0].j.status, "confirmed");
    await expectError(c, `select approve_booking_request($1, $2, $3, $4)`, [x.t, r2, p.id, x.desk], /REQUEST_NOT_OPEN/);

    const { rows: [{ id: r3 }] } = await req(c, x, at(2, "10:15"), { token: "link-3" });
    await expectError(c, `select set_appointment_status($1, $2, 'cancelled', '', 'member', $3)`, [x.t, r3, x.desk], /REASON_REQUIRED/);
    await c.query(`select set_appointment_status($1, $2, 'cancelled', 'Doctor on leave that day, offered Sunday', 'member', $3)`, [x.t, r3, x.desk]);
    const declined = (await c.query(`select public_booking_status($1, 'link-3') j`, [x.slug])).rows[0].j;
    assert.equal(declined.status, "cancelled");
    assert.equal(declined.cancel_reason, "Doctor on leave that day, offered Sunday", "the requester sees why");

    await asOwner(c);
    await c.query(`insert into appointments (tenant_id, doctor_member_id, mode, appointment_date, scheduled_range, source, booked_by_kind, status, requester_name, requester_phone)
                   values ($1, $2, 'slot', current_date, tstzrange(now() - interval '2 hours', now() - interval '105 minutes'), 'online', 'guest', 'requested', 'Late One', '9800000077')`, [x.t, x.doc]);
    await asApp(c);
    assert.equal((await c.query(`select expire_booking_requests($1) n`, [x.t])).rows[0].n, 1, "an unreviewed past request is closed");
    await asOwner(c);
  });
});

test("ISOLATION: staff can't approve another clinic's request or link another clinic's patient", async () => {
  await withTx(async (c) => {
    const a = await clinic(c), b = await clinic(c);
    await asApp(c);
    const { rows: [{ id: rb }] } = await req(c, b, at(2, "09:00"));
    const { rows: [{ id: ra }] } = await req(c, a, at(2, "09:00"));
    await asOwner(c);
    const { rows: [pb] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'B Patient', 'male', 40) returning id`, [b.t]);
    const { rows: [pa] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'A Patient', 'male', 40) returning id`, [a.t]);
    await asApp(c);
    await expectError(c, `select approve_booking_request($1, $2, $3, $4)`, [a.t, rb, pa.id, a.desk], /APPOINTMENT_NOT_FOUND/);
    await expectError(c, `select approve_booking_request($1, $2, $3, $4)`, [a.t, ra, pb.id, a.desk], /PATIENT_NOT_FOUND/);
    await expectError(c, `select approve_booking_request($1, $2, $3, $4)`, [a.t, ra, pa.id, b.desk], /MEMBER_NOT_FOUND/);
    assert.equal((await c.query(`select public_booking_status($1, (select manage_token_hash from appointments where id = $2)) j`, [a.slug, rb])).rows[0].j, null, "B's link doesn't open on A's site");
    await asOwner(c);
  });
});

test("approve as a new patient is all-or-nothing: a failed approval registers nobody", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    const { rows: [{ id }] } = await req(c, x, at(2, "11:00"), { name: "Nima Sherpa", phone: "9841777000" });
    const { rows: [{ p }] } = await c.query(`select approve_booking_request_new_patient($1, $2, 'Nima Sherpa', 'male', 45, null, '9841777000', $3) p`, [x.t, id, x.desk]);
    assert.ok(p);
    await expectError(c, `select approve_booking_request_new_patient($1, $2, 'Nima Sherpa', 'male', 45, null, '9841777000', $3)`, [x.t, id, x.desk], /REQUEST_NOT_OPEN/);
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from patients where tenant_id = $1`, [x.t])).rows[0].n, 1);
    assert.equal((await c.query(`select created_via from patients where id = $1`, [p])).rows[0].created_via, "online");
  });
});
