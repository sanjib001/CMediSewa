// B4b clinical: the CARE MATRIX (who may read/write whose chart), audited reads, PIN ceiling,
// encounter and prescription lifecycles, break-glass, and that the app role can't touch the
// clinical tables directly. Every function call runs as service_role, like the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

async function authUser(c) {
  const id = uuid();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
    [id, `cl-${id.slice(0, 8)}@example.invalid`]);
  return id;
}
/** A member with a role made of `perms`, optionally a (verified) professional credential. */
async function staff(c, x, { perms = [], profession = null, verified = true, admin = false, name = "Staff" } = {}) {
  const { rows: [m] } = await c.query(`insert into tenant_members (tenant_id, auth_user_id, membership_role, display_name, email) values ($1, $2, $3, $4, $5) returning id`,
    [x.t, await authUser(c), admin ? "tenant_admin" : "tenant_member", name, `m-${uuid().slice(0, 8)}@example.invalid`]);
  if (perms.length) {
    const { rows: [r] } = await c.query(`insert into tenant_roles (tenant_id, name, permissions) values ($1, $2, $3) returning id`, [x.t, `R-${uuid().slice(0, 6)}`, perms]);
    await c.query(`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [x.t, m.id, r.id]);
  }
  if (profession) {
    const { rows: [cr] } = await c.query(`insert into member_credentials (tenant_id, member_id, profession, council, registration_no) values ($1, $2, $3, 'NMC', $4) returning id`,
      [x.t, m.id, profession, `R-${uuid().slice(0, 8)}`]);
    if (verified) await c.query(`select verify_member_credential($1, $2, null)`, [cr.id, x.admin]);
  }
  return m.id;
}
const DOCTOR = ["view_patients", "view_queue", "record_vitals", "view_clinical", "write_consultation", "issue_prescriptions"];
async function clinic(c) {
  const t = await makeTenant(c);
  await c.query(`update tenants set status = 'active' where id = $1`, [t]);
  await c.query(`insert into tenant_settings (tenant_id) values ($1)`, [t]);
  const x = { t };
  const { rows: [a] } = await c.query(`insert into tenant_members (tenant_id, auth_user_id, membership_role, display_name, email) values ($1, $2, 'tenant_admin', 'Admin', $3) returning id`,
    [t, await authUser(c), `a-${uuid().slice(0, 8)}@example.invalid`]);
  x.admin = a.id;
  x.doc = await staff(c, x, { perms: DOCTOR, profession: "doctor", name: "Dr. One" });
  x.doc2 = await staff(c, x, { perms: DOCTOR, profession: "doctor", name: "Dr. Two" });
  for (const d of [x.doc, x.doc2]) await c.query(`insert into doctor_profiles (tenant_id, member_id) values ($1, $2)`, [t, d]);
  const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'Maya Gurung', 'female', 29) returning id`, [t]);
  const { rows: [q] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'Bikash Rai', 'male', 51) returning id`, [t]);
  x.p = p.id; x.q = q.id;
  return x;
}
/** A visit for (patient, doctor) on a day offset from today (owner insert: front desk is tested elsewhere). */
async function visit(c, x, patient, doctor, dayOffset = 0, status = "waiting") {
  const { rows: [v] } = await c.query(`insert into visits (tenant_id, patient_id, doctor_member_id, visit_date, token_no, checked_in_by, idempotency_key, status)
     values ($1, $2, $3, (now() at time zone 'Asia/Kathmandu')::date + $4::int, (select coalesce(max(token_no), 0) + 1 from visits where tenant_id = $1), $5, gen_random_uuid(), $6) returning id`,
    [x.t, patient, doctor, dayOffset, x.admin, status]);
  return v.id;
}
const scope = async (c, x, m, p) => (await c.query(`select clinical_scope($1, $2, $3) s`, [x.t, m, p])).rows[0].s;
const asApp = (c) => c.query(`set role service_role`);
const asOwner = (c) => c.query(`reset role`);

test("CARE MATRIX: only the treating doctor writes; no relationship, unverified doctor, admin and PIN all refused", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const unverified = await staff(c, x, { perms: DOCTOR, profession: "doctor", verified: false, name: "Dr. Unverified" });
    await c.query(`insert into doctor_profiles (tenant_id, member_id) values ($1, $2)`, [x.t, unverified]);
    const nurse = await staff(c, x, { perms: ["view_patients", "record_vitals", "view_clinical"], profession: "nurse", name: "Nurse" });
    const registrar = await staff(c, x, { perms: ["view_patients", "manage_queue", "record_vitals"], name: "Registrar" });
    await visit(c, x, x.p, x.doc);
    await visit(c, x, x.p, unverified);
    await asApp(c);
    assert.equal(await scope(c, x, x.doc, x.p), "write", "C1: treating doctor today");
    assert.equal(await scope(c, x, x.doc, x.q), null, "no relationship with the other patient");
    assert.equal(await scope(c, x, x.doc2, x.p), "vitals", "another doctor: vitals only while the patient is in the clinic (C3), never notes");
    assert.equal(await scope(c, x, unverified, x.p), null, "unverified credential: clinical keys never apply (D-06)");
    assert.equal(await scope(c, x, x.admin, x.p), null, "clinic admin has no implicit clinical access");
    assert.equal(await scope(c, x, nurse, x.p), "vitals", "C3: nurse, patient waiting today");
    assert.equal(await scope(c, x, registrar, x.p), null, "record_vitals without a nurse/doctor credential does nothing");

    const chart = (await c.query(`select open_chart($1, $2, $3, 'A2') j`, [x.t, x.doc, x.p])).rows[0].j;
    assert.equal(chart.scope, "write");
    assert.ok(Array.isArray(chart.encounters));
    assert.equal((await c.query(`select open_chart($1, $2, $3, 'A1') j`, [x.t, x.doc, x.p])).rows[0].j.error, "PASSWORD_REQUIRED");
    assert.equal((await c.query(`select open_chart($1, $2, $3, 'A2') j`, [x.t, x.doc, x.q])).rows[0].j.error, "NO_CLINICAL_ACCESS");
    assert.equal((await c.query(`select open_chart($1, $2, $3, 'A3') j`, [x.t, x.admin, x.p])).rows[0].j.error, "NO_CLINICAL_ACCESS", "refused, and the refusal is logged");
    const nurseView = (await c.query(`select open_chart($1, $2, $3, 'A2') j`, [x.t, nurse, x.p])).rows[0].j;
    assert.equal(nurseView.scope, "vitals");
    assert.equal(nurseView.encounters, undefined, "vitals scope never sees notes or prescriptions");
    await asOwner(c);
    const { rows: audit } = await c.query(`select actor_id, outcome, reason from audit_log where tenant_id = $1 and action = 'patient.chart_read' order by id`, [x.t]);
    assert.deepEqual(audit.map((a) => a.outcome), ["success", "denied", "denied", "denied", "success"], "every opening, allowed or not, is logged");
    assert.equal(audit[1].reason, "assurance");
  });
});

test("encounter + prescription lifecycle: draft, issue, finalize, then locked; addendum only", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const v = await visit(c, x, x.p, x.doc, 0, "with_doctor");
    await asApp(c);
    const { rows: [{ e }] } = await c.query(`select start_encounter($1, $2, $3, 'A2') e`, [x.t, x.doc, v]);
    assert.equal((await c.query(`select start_encounter($1, $2, $3, 'A2') e`, [x.t, x.doc, v])).rows[0].e, e, "reopening returns the same draft");
    await expectError(c, `select start_encounter($1, $2, $3, 'A2')`, [x.t, x.doc2, v], /NO_CLINICAL_ACCESS|NOT_YOUR_VISIT/);
    await expectError(c, `select finalize_encounter($1, $2, $3, 'A2')`, [x.t, x.doc, e], /ENCOUNTER_EMPTY/);
    await c.query(`select save_encounter($1, $2, $3, $4, $5, 'A2')`, [x.t, x.doc, e,
      { chief_complaint: "Fever for 3 days", examination: "Temp 38.6", assessment: "Viral fever", plan: "Rest, fluids" },
      JSON.stringify([{ text: "Viral fever", icd10: "b34.9" }, { text: "Dehydration, mild" }])]);
    await c.query(`select record_vitals($1, $2, $3, $4, $5, 'A2')`, [x.t, x.doc, x.p, v, { systolic: 118, diastolic: 76, pulse: 96, temp_c: 38.6, spo2: 98 }]);
    await expectError(c, `select record_vitals($1, $2, $3, $4, $5, 'A2')`, [x.t, x.doc, x.p, v, { systolic: 400, diastolic: 76 }], /check/);
    await c.query(`select set_allergy($1, $2, $3, null, 'Penicillin', 'Rash', 'moderate', false, 'A2')`, [x.t, x.doc, x.p]);
    const { rows: [{ rx }] } = await c.query(`select save_prescription($1, $2, $3, $4, 'Review if fever persists', 'A2') rx`, [x.t, x.doc, e,
      JSON.stringify([{ medicine_text: "Paracetamol", strength: "500 mg", form: "tab", dose: "1 tab", frequency: "every 6 hours if fever", duration_days: 3, quantity: 12 },
                      { medicine_text: "ORS", form: "sachet", dose: "1 in 1 L water", frequency: "as needed", quantity: 5 }])]);
    await expectError(c, `select finalize_encounter($1, $2, $3, 'A2')`, [x.t, x.doc, e], /PRESCRIPTION_NOT_ISSUED/);
    const { rows: [{ n }] } = await c.query(`select issue_prescription($1, $2, $3, 'A2') n`, [x.t, x.doc, rx]);
    assert.equal(n, "RX-000001");
    await c.query(`select finalize_encounter($1, $2, $3, 'A2')`, [x.t, x.doc, e]);
    await expectError(c, `select save_encounter($1, $2, $3, '{"chief_complaint":"changed"}', null, 'A2')`, [x.t, x.doc, e], /ENCOUNTER_FINALIZED/);
    await expectError(c, `select save_prescription($1, $2, $3, '[]', null, 'A2')`, [x.t, x.doc, e], /ENCOUNTER_FINALIZED/);
    await c.query(`select add_addendum($1, $2, $3, 'Lab: dengue NS1 negative.', 'A2')`, [x.t, x.doc, e]);
    await expectError(c, `select cancel_prescription($1, $2, $3, '', 'A2')`, [x.t, x.doc, rx], /REASON_REQUIRED/);

    const chart = (await c.query(`select open_chart($1, $2, $3, 'A2') j`, [x.t, x.doc, x.p])).rows[0].j;
    const enc = chart.encounters[0];
    assert.equal(enc.status, "finalized");
    assert.deepEqual(enc.diagnoses.map((d) => [d.text, d.icd10, d.is_primary]), [["Viral fever", "B34.9", true], ["Dehydration, mild", null, false]]);
    assert.equal(enc.prescription.rx_number, "RX-000001");
    assert.equal(enc.prescription.items.length, 2);
    assert.equal(enc.addenda.length, 1);
    assert.equal(chart.allergies[0].allergen, "Penicillin");
    assert.equal(chart.vitals[0].pulse, 96);

    await asOwner(c);
    // Even the owner role can't rewrite history: triggers, not just grants.
    await expectError(c, `update encounters set assessment = 'x' where id = $1`, [e], /ENCOUNTER_FINALIZED/);
    await expectError(c, `update prescription_items set quantity = 99 where prescription_id = $1`, [rx], /PRESCRIPTION_LOCKED/);
    await expectError(c, `delete from diagnoses where encounter_id = $1`, [e], /ENCOUNTER_FINALIZED/);
    await expectError(c, `update vitals set pulse = 60 where patient_id = $1`, [x.p], /APPEND_ONLY/);
  });
});

test("past and future care: earlier doctor reads but can't write; drafts stay private; grants and break-glass", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const old = await visit(c, x, x.p, x.doc, -30, "closed");
    await asOwner(c);
    const { rows: [{ id: e }] } = await c.query(`insert into encounters (tenant_id, patient_id, doctor_member_id, visit_id, chief_complaint, status, finalized_at)
       values ($1, $2, $3, $4, 'Old visit', 'finalized', now() - interval '30 days') returning id`, [x.t, x.p, x.doc, old]);
    const draftVisit = await visit(c, x, x.p, x.doc2, 0, "with_doctor");
    await asApp(c);
    assert.equal(await scope(c, x, x.doc, x.p), "read", "C2: past encounter → read only");
    await expectError(c, `select start_encounter($1, $2, $3, 'A2')`, [x.t, x.doc, old], /NO_CLINICAL_ACCESS/);
    const { rows: [{ e2 }] } = await c.query(`select start_encounter($1, $2, $3, 'A2') e2`, [x.t, x.doc2, draftVisit]);
    await c.query(`select save_encounter($1, $2, $3, '{"chief_complaint":"Today''s draft"}', null, 'A2')`, [x.t, x.doc2, e2]);
    const seen = (await c.query(`select open_chart($1, $2, $3, 'A2') j`, [x.t, x.doc, x.p])).rows[0].j.encounters.map((z) => z.chief_complaint);
    assert.deepEqual(seen, ["Old visit"], "another doctor's unfinished draft is not shown");
    assert.ok(e);

    // a referral grant lets a third doctor read; break-glass needs the key, a reason and a fresh password
    await asOwner(c);
    const doc3 = await staff(c, x, { perms: DOCTOR, profession: "doctor", name: "Dr. Three" });
    await asApp(c);
    assert.equal(await scope(c, x, doc3, x.q), null);
    await expectError(c, `select break_glass($1, $2, $3, 'Unconscious patient in ER', 'A2', now())`, [x.t, doc3, x.q], /NO_BREAK_GLASS_RIGHT/);
    await asOwner(c);
    const er = await staff(c, x, { perms: [...DOCTOR, "break_glass"], profession: "doctor", name: "Dr. ER" });
    await c.query(`insert into care_access_grants (tenant_id, member_id, patient_id, kind, reason, granted_by, expires_at) values ($1, $2, $3, 'referral', 'Referred for opinion', $4, now() + interval '7 days')`, [x.t, doc3, x.q, x.doc]);
    await asApp(c);
    assert.equal(await scope(c, x, doc3, x.q), "read", "C4: referral grant");
    await expectError(c, `select break_glass($1, $2, $3, 'Unconscious patient', 'A2', now() - interval '10 minutes')`, [x.t, er, x.q], /REAUTH_REQUIRED/);
    await expectError(c, `select break_glass($1, $2, $3, 'x', 'A2', now())`, [x.t, er, x.q], /REASON_REQUIRED/);
    await c.query(`select break_glass($1, $2, $3, 'Unconscious patient in ER', 'A2', now())`, [x.t, er, x.q]);
    assert.equal(await scope(c, x, er, x.q), "read", "C6: break-glass read for 60 minutes");
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from audit_log where tenant_id = $1 and action = 'clinical.break_glass'`, [x.t])).rows[0].n, 1);
  });
});

test("the app role can't read or write clinical tables directly; another clinic can't reach the chart", async () => {
  await withTx(async (c) => {
    const x = await clinic(c), y = await clinic(c);
    await visit(c, x, x.p, x.doc);
    await asApp(c);
    for (const t of ["encounters", "vitals", "diagnoses", "prescriptions", "prescription_items", "patient_allergies", "care_access_grants", "encounter_addenda"]) {
      await expectError(c, `select * from ${t} limit 1`, [], /permission denied/);
    }
    await expectError(c, `insert into vitals (tenant_id, patient_id, recorded_by, pulse) values ($1, $2, $3, 80)`, [x.t, x.p, x.doc], /permission denied/);
    // Clinic Y's doctor, clinic Y's tenant id, clinic X's patient: nothing.
    assert.equal(await scope(c, y, y.doc, x.p), null);
    assert.equal((await c.query(`select clinical_scope($1, $2, $3) s`, [x.t, y.doc, x.p])).rows[0].s, null, "a doctor of another clinic, even with X's tenant id");
    assert.equal((await c.query(`select open_chart($1, $2, $3, 'A2') j`, [y.t, y.doc, x.p])).rows[0].j.error, "NO_CLINICAL_ACCESS");
    await asOwner(c);
  });
});
