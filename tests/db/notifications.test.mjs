// B9a realtime and notifications: booking and Rx notifications to the right staff, PHI-minimal emails,
// the outbox (once, retries, reclaim), push devices, live events, isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, makeTenant, uuid } from "./helpers.mjs";

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


// ── B9a realtime, notifications, outbox ──
const outbox = async (c, t, where = "true") => (await c.query(`select channel, kind, recipient, status, payload from notification_outbox where tenant_id = $1 and ${where} order by id`, [t])).rows;
const inbox = async (c, m) => (await c.query(`select kind, title, body, link, read_at from notifications where member_id = $1 order by created_at`, [m])).rows;
async function pharmacist(c, x) {
  const ph = await member(c, x.t);
  const { rows: [r] } = await c.query(`insert into tenant_roles (tenant_id, name, permissions) values ($1, 'Dispensing', array['dispense_prescription']) returning id`, [x.t]);
  await c.query(`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [x.t, ph, r.id]);
  const { rows: [cr] } = await c.query(`insert into member_credentials (tenant_id, member_id, profession, council, registration_no) values ($1, $2, 'pharmacist', 'NPC', $3) returning id`, [x.t, ph, `P-${uuid().slice(0, 6)}`]);
  await c.query(`select verify_member_credential($1, $2, null)`, [cr.id, x.admin]);
  return ph;
}

test("booking request → staff notification; approve / decline / cancel → one email each, PHI-minimal; reminders cancelled", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    const { rows: [{ id: a1 }] } = await req(c, x, at(2, "09:00"), { email: "Asha.Lama@Example.com", token: "n-1" });
    await asOwner(c);
    const n = await inbox(c, x.admin);
    assert.equal(n.length, 1);
    assert.equal(n[0].kind, "booking_request");
    assert.ok(!/Fever|Asha/.test(`${n[0].title} ${n[0].body}`), "no reason for visit, no patient name");
    assert.equal((await inbox(c, x.desk)).length, 0, "only people who manage appointments");
    assert.equal((await outbox(c, x.t, "channel = 'email'")).length, 0, "no email while it's only a request");
    const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years, phone) values ($1, 'Asha Lama', 'female', 30, '9841000002') returning id`, [x.t]);
    await asApp(c);
    await c.query(`select approve_booking_request($1, $2, $3, $4)`, [x.t, a1, p.id, x.desk]);
    await asOwner(c);
    let mail = await outbox(c, x.t, "channel = 'email'");
    assert.deepEqual(mail.map((m) => m.kind), ["booking_confirmed", "booking_reminder"], "confirmation now, reminder for later (B9b)");
    assert.equal(mail[0].recipient, "asha.lama@example.com");
    assert.equal(mail[0].payload.time, "09:00");
    assert.ok(!JSON.stringify(mail[0].payload).includes("Fever"), "the email never carries the reason");
    // a reminder queued for later is cancelled with the appointment
    await c.query(`select queue_email($1, 'booking_reminder', 'appointment', $2, 'asha.lama@example.com', '{}'::jsonb, now() + interval '1 day')`, [x.t, a1]);
    await asApp(c);
    await c.query(`select set_appointment_status($1, $2, 'cancelled', 'Doctor called away', 'member', $3)`, [x.t, a1, x.desk]);
    const { rows: [{ id: a2 }] } = await req(c, x, at(2, "10:00"), { email: "ram@example.com", token: "n-2" });
    await c.query(`select set_appointment_status($1, $2, 'cancelled', 'Fully booked', 'member', $3)`, [x.t, a2, x.desk]);
    await asOwner(c);
    mail = await outbox(c, x.t, "channel = 'email'");
    assert.deepEqual(mail.map((m) => [m.kind, m.status]), [["booking_confirmed", "cancelled"], ["booking_reminder", "cancelled"], ["booking_cancelled", "pending"], ["booking_declined", "pending"]]);
    await asApp(c);
    await c.query(`select set_appointment_status($1, $2, 'cancelled', 'again', 'member', $3)`, [x.t, a2, x.desk]).catch(() => {});
    await asOwner(c);
    assert.equal((await outbox(c, x.t, "kind = 'booking_declined'")).length, 1, "never twice");
    // (the unsent confirmation was cancelled with the appointment: no "confirmed" then "cancelled" pair)
  });
});

test("outbox: claimed once (skip locked), retried with backoff, failed after 5, stuck rows reclaimed; bad addresses never queued", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await c.query(`select queue_email($1, 'test_kind', 'test', 'r1', 'a@example.com', '{}'::jsonb)`, [x.t]);
    await c.query(`select queue_email($1, 'test_kind', 'test', 'r1', 'A@Example.com', '{}'::jsonb)`, [x.t]);
    await c.query(`select queue_email($1, 'test_kind', 'test', 'r2', 'not-an-address', '{}'::jsonb)`, [x.t]);
    assert.equal((await outbox(c, x.t)).length, 1, "same event and address once; a bad address never");
    await asApp(c);
    const take = async () => (await c.query(`select id, attempts from claim_outbox(200) where tenant_id = $1`, [x.t])).rows;
    const [row] = await take();
    assert.ok(row);
    assert.equal((await take()).length, 0, "a claimed row isn't handed out again");
    await c.query(`select complete_outbox($1, 'retry', 'timeout')`, [row.id]);
    await asOwner(c);
    let { rows: [o] } = await c.query(`select status, attempts, next_attempt_at > now() later from notification_outbox where id = $1`, [row.id]);
    assert.deepEqual([o.status, o.attempts, o.later], ["pending", 1, true], "back in the queue, later");
    await c.query(`update notification_outbox set attempts = 4, next_attempt_at = now() - interval '1 minute' where id = $1`, [row.id]);
    await asApp(c);
    const [again] = await take();
    await c.query(`select complete_outbox($1, 'retry', 'timeout')`, [again.id]);
    await asOwner(c);
    ({ rows: [o] } = await c.query(`select status from notification_outbox where id = $1`, [row.id]));
    assert.equal(o.status, "failed", "given up after 5 tries");
    await c.query(`select queue_email($1, 'test_kind', 'test', 'r3', 'b@example.com', '{}'::jsonb)`, [x.t]);
    await asApp(c);
    const [stuck] = await take();
    await asOwner(c);
    await c.query(`update notification_outbox set claimed_at = now() - interval '11 minutes' where id = $1`, [stuck.id]);
    await asApp(c);
    assert.equal((await take())[0]?.id, stuck.id, "a row stuck in sending is claimed again");
    await c.query(`select complete_outbox($1, 'skipped', 'no mail key (dry run)')`, [stuck.id]);
    await c.query(`select complete_outbox($1, 'sent', null)`, [stuck.id]);
    await asOwner(c);
    assert.equal((await c.query(`select status from notification_outbox where id = $1`, [stuck.id])).rows[0].status, "skipped", "a finished row can't change again");
  });
});

test("Rx issued → verified pharmacists only (no patient, no medicines); push per device, disabled when gone; read marks", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const ph = await pharmacist(c, x);
    await asApp(c);
    await c.query(`select save_push_subscription($1, $2, 'https://push.example.invalid/abc', 'BPpublickeypublickeypublickey000', 'authsecret123', 'Test browser')`, [x.t, ph]);
    await asOwner(c);
    const { rows: [pt] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'Sita Gurung', 'female', 34) returning id`, [x.t]);
    const rx = async (no) => {
      const { rows: [e] } = await c.query(`insert into encounters (tenant_id, patient_id, doctor_member_id, status, finalized_at, chief_complaint) values ($1, $2, $3, 'finalized', now(), 'Cough') returning id`, [x.t, pt.id, x.doc]);
      const { rows: [r] } = await c.query(`insert into prescriptions (tenant_id, patient_id, encounter_id, doctor_member_id, status) values ($1, $2, $3, $4, 'draft') returning id`, [x.t, pt.id, e.id, x.doc]);
      await c.query(`insert into prescription_items (tenant_id, prescription_id, line_no, medicine_text, quantity) values ($1, $2, 1, 'Amoxicillin 500', 15)`, [x.t, r.id]);
      await c.query(`update prescriptions set status = 'issued', rx_number = $2, issued_at = now() where id = $1`, [r.id, no]);
    };
    await rx("RX-N0001");
    const n = await inbox(c, ph);
    assert.equal(n.length, 1);
    assert.ok(n[0].body.includes("RX-N0001") && !/Sita|Amoxicillin|Cough/.test(n[0].body), "number and doctor only");
    assert.equal((await inbox(c, x.admin)).filter((i) => i.kind === "rx_issued").length, 0, "a clinic admin isn't a pharmacist");
    const push = await outbox(c, x.t, "channel = 'push'");
    assert.equal(push.length, 1);
    assert.equal(push[0].payload.title, "Prescription to dispense");
    await asApp(c);
    const [p1] = (await c.query(`select id from claim_outbox(200) where tenant_id = $1 and channel = 'push'`, [x.t])).rows;
    await c.query(`select complete_outbox($1, 'failed', 'gone (410)', true)`, [p1.id]);
    await asOwner(c);
    await rx("RX-N0002");
    assert.equal((await outbox(c, x.t, "channel = 'push'")).length, 1, "no push to a device that's gone");
    await asApp(c);
    assert.equal((await c.query(`select mark_notifications_read($1, $2, null) n`, [x.t, ph])).rows[0].n, 2);
    assert.equal((await c.query(`select mark_notifications_read($1, $2, null) n`, [x.t, x.admin])).rows[0].n, 0, "the admin has none of their own to mark");
    await asOwner(c);
    assert.ok((await inbox(c, ph)).every((i) => i.read_at), "the pharmacist's stay read");
    await asApp(c);
    await asOwner(c);
  });
});

test("live events: topic only, one per transaction, a person's own topic stays theirs; ISOLATION", async () => {
  await withTx(async (c) => {
    const a = await clinic(c), b = await clinic(c);
    await asApp(c);
    const start = Number((await c.query(`select latest_event_id($1) n`, [a.t])).rows[0].n);
    await req(c, a, at(2, "09:00"), { token: "e-1" });
    await req(c, b, at(2, "09:00"), { token: "e-2" });
    const ev = (await c.query(`select topic from events_since($1, $2, $3, array['bookings', 'queue', 'notifications'])`, [a.t, a.desk, start])).rows.map((r) => r.topic);
    assert.deepEqual(ev.sort(), ["bookings", "queue"], "one of each per transaction; the admin's notification signal isn't the desk's");
    const evAdmin = (await c.query(`select topic from events_since($1, $2, $3, array['notifications'])`, [a.t, a.admin, start])).rows;
    assert.equal(evAdmin.length, 1);
    const evB = (await c.query(`select count(*)::int n from events_since($1, $2, 0, array['bookings'])`, [a.t, a.admin])).rows[0].n;
    const evBOther = (await c.query(`select count(*)::int n from realtime_events where tenant_id = $1 and topic = 'bookings'`, [a.t])).rows[0]?.n;
    assert.equal(evB, evBOther, "never another clinic's events");
    await asOwner(c);
  });
});

// ── B9b reminders and daily appointment jobs ──
test("reminder queued on confirmation, due N hours before; 0 = off; cancelled with the appointment", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const p = (await c.query(`insert into patients (tenant_id, full_name, sex, age_years, email) values ($1, 'Asha Lama', 'female', 30, 'asha@example.com') returning id`, [x.t])).rows[0].id;
    await asApp(c);
    const { rows: [{ id: a1 }] } = await req(c, x, at(2, "09:00"), { token: "r-1" });
    await c.query(`select approve_booking_request($1, $2, $3, $4)`, [x.t, a1, p, x.desk]);
    await asOwner(c);
    const { rows: [r] } = await c.query(`select status, recipient, next_attempt_at, (select lower(scheduled_range) from appointments where id = $2) starts
                                           from notification_outbox where tenant_id = $1 and kind = 'booking_reminder' and ref_id = $2::text`, [x.t, a1]);
    assert.equal(r.status, "pending");
    assert.equal(r.recipient, "asha@example.com", "the patient's own email when the record has one");
    assert.equal(r.starts.getTime() - r.next_attempt_at.getTime(), 24 * 3600_000, "due 24 hours before");
    await c.query(`update tenant_settings set reminder_hours_before = 0 where tenant_id = $1`, [x.t]);
    await asApp(c);
    const { rows: [{ id: a2 }] } = await req(c, x, at(2, "10:00"), { token: "r-2" });
    await asOwner(c);
    const { rows: [q] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years, email) values ($1, 'Ram Thapa', 'male', 40, 'ram@example.com') returning id`, [x.t]);
    await asApp(c);
    await c.query(`select approve_booking_request($1, $2, $3, $4)`, [x.t, a2, q.id, x.desk]);
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from notification_outbox where kind = 'booking_reminder' and ref_id = $1::text`, [a2])).rows[0].n, 0, "reminders off");
  });
});

test("daily jobs: confirmed but never came → no-show; unreviewed requests released; only this clinic when asked", async () => {
  await withTx(async (c) => {
    const x = await clinic(c), y = await clinic(c);
    const p = (await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'Asha Lama', 'female', 30) returning id`, [x.t])).rows[0].id;
    await asApp(c);
    const { rows: [{ id: a1 }] } = await req(c, x, at(2, "09:00"), { token: "d-1" });
    await c.query(`select approve_booking_request($1, $2, $3, $4)`, [x.t, a1, p, x.desk]);
    const { rows: [{ id: a2 }] } = await req(c, x, at(2, "09:15"), { token: "d-2" });
    const { rows: [{ id: b1 }] } = await req(c, y, at(2, "09:00"), { token: "d-3" });
    await asOwner(c);
    // move both of x's appointments two days into the past (as if time went by)
    await c.query(`update appointments set appointment_date = appointment_date - 4, scheduled_range = tstzrange(lower(scheduled_range) - interval '4 days', upper(scheduled_range) - interval '4 days') where id = any($1)`, [[a1, a2]]);
    await asApp(c);
    const r = (await c.query(`select run_daily_jobs($1) r`, [x.t])).rows[0].r;
    assert.deepEqual([r.no_shows, r.requests_expired], [1, 1]);
    await asOwner(c);
    const st = Object.fromEntries((await c.query(`select id, status from appointments where id = any($1)`, [[a1, a2, b1]])).rows.map((a) => [a.id, a.status]));
    assert.deepEqual([st[a1], st[a2], st[b1]], ["no_show", "cancelled", "requested"], "the other clinic untouched");
    const { rows: [m] } = await c.query(`select kind, payload from notification_outbox where ref_id = $1::text and channel = 'email'`, [a2]);
    assert.ok(!m || m.kind === "booking_declined", "a released request tells the requester (if they gave an email)");
  });
});

test("outbox respects the clinic: closed → cancelled, suspended → waits, active → sent", async () => {
  await withTx(async (c) => {
    const a = await clinic(c), s = await clinic(c), z = await clinic(c);
    for (const x of [a, s, z]) await c.query(`select queue_email($1, 'test_kind', 'test', $2, 'p@example.com', '{}'::jsonb)`, [x.t, x.t]);
    await c.query(`update tenants set status = 'suspended' where id = $1`, [s.t]);
    await c.query(`update tenants set status = 'closed' where id = $1`, [z.t]);
    await asApp(c);
    const got = (await c.query(`select tenant_id from claim_outbox(200) where tenant_id = any($1)`, [[a.t, s.t, z.t]])).rows.map((r) => r.tenant_id);
    await asOwner(c);
    assert.deepEqual(got, [a.t], "only the active clinic's message is claimed");
    const st = Object.fromEntries((await c.query(`select tenant_id, status from notification_outbox where tenant_id = any($1)`, [[a.t, s.t, z.t]])).rows.map((r) => [r.tenant_id, r.status]));
    assert.deepEqual([st[a.t], st[s.t], st[z.t]], ["sending", "pending", "cancelled"]);
  });
});
