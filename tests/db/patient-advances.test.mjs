// M-52 patient advances: deposit, refund, use against dues, automatic use at check-in and at
// the counter (even where dues aren't allowed), a void gives it back, merges carry it, and the
// books check agrees with the journal throughout. RPCs run as service_role, like the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

async function authUser(c) {
  const id = uuid();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`, [id, `pa-${id.slice(0, 8)}@example.invalid`]);
  return id;
}
async function member(c, t, { admin = false, name = "Staff", keys = null } = {}) {
  const { rows: [m] } = await c.query(`insert into tenant_members (tenant_id, auth_user_id, membership_role, display_name, email) values ($1, $2, $3, $4, $5) returning id`,
    [t, await authUser(c), admin ? "tenant_admin" : "tenant_member", name, `m-${uuid().slice(0, 8)}@example.invalid`]);
  if (keys) {
    const { rows: [r] } = await c.query(`insert into tenant_roles (tenant_id, name, permissions) values ($1, $2, $3) returning id`, [t, `R-${uuid().slice(0, 6)}`, keys]);
    await c.query(`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [t, m.id, r.id]);
  }
  return m.id;
}
/** Active clinic, dues NOT allowed, an admin, a cashier (pharmacy_sell only), a desk member with no keys, a doctor (fee 500), an OPD service, a sellable store with a dressing service. */
async function clinic(c, { credit = false } = {}) {
  const t = await makeTenant(c);
  await c.query(`update tenants set status = 'active' where id = $1`, [t]);
  const { rows: [bp] } = await c.query(`insert into billing_profiles (tenant_id, name, legal_name, invoice_prefix, is_default) values ($1, 'Clinic', 'Test Clinic', 'T', true) returning id`, [t]);
  await c.query(`insert into tenant_settings (tenant_id, default_billing_profile_id, allow_credit, credit_limit_per_patient) values ($1, $2, $3, 5000)`, [t, bp.id, credit]);
  const admin = await member(c, t, { admin: true }), desk = await member(c, t), cashier = await member(c, t, { keys: ["pharmacy_sell", "all_stores"] });
  const doc = await member(c, t, { name: "Dr. Advance Test" });
  await c.query(`insert into doctor_profiles (tenant_id, member_id, consultation_fee) values ($1, $2, 500)`, [t, doc]);
  await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes, effective_from)
                 select $1, $2, w, '00:00', '23:45', 15, current_date - 1 from generate_series(0, 6) w`, [t, doc]);
  const { rows: [svc] } = await c.query(`insert into services (tenant_id, name, kind, price_npr) values ($1, 'General OPD', 'consultation', 300) returning id`, [t]);
  const { rows: [dress] } = await c.query(`insert into services (tenant_id, name, kind, price_npr) values ($1, 'Dressing', 'procedure', 250) returning id`, [t]);
  const { rows: [st] } = await c.query(`insert into stores (tenant_id, code, name, kind, billing_profile_id, is_sellable, is_dispensing, is_receiving) values ($1, 'PHARM', 'Pharmacy', 'pharmacy', $2, true, true, true) returning id`, [t, bp.id]);
  const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years, phone) values ($1, 'Kamala Shrestha', 'female', 61, '9849000001') returning id`, [t]);
  return { t, admin, desk, cashier, doc, svc: svc.id, dress: dress.id, store: st.id, p: p.id };
}
const asApp = (c) => c.query(`set role service_role`);
const asOwner = (c) => c.query(`reset role`);
const deposit = (c, x, cash, online = 0, by = x.admin, p = x.p) => c.query(`select record_patient_advance($1, $2, $3, 'deposit', $4, $5, $6, null, 'Before the operation', $7, 'A1', null) r`,
  [x.t, uuid(), p, cash, online, online ? "esewa" : null, by]).then((r) => r.rows[0].r);
const balance = (c, x, p = x.p) => c.query(`select patient_advance_balance($1, $2)::numeric b`, [x.t, p]).then((r) => Number(r.rows[0].b));
const checkIn = (c, x, cash, key = uuid()) => c.query(`select check_in_visit($1, $2, $3, $4, null, $5, 0, $6, 0, null, null, $7, 'A1', null) r`, [x.t, key, x.p, x.doc, x.svc, cash, x.admin]).then((r) => r.rows[0].r);
const books = async (c, x) => {
  const r = (await c.query(`select verify_finance_integrity($1) r`, [x.t])).rows[0].r;
  return r.checks.filter((k) => !k.ok).map((k) => `${k.check}: documents ${k.documents} journal ${k.journal}`);
};
const advRow = (c, t) => c.query(`select coalesce(-sum(debit - credit), 0)::numeric held from ledger_entries where tenant_id = $1 and account_code = 'PATIENT_ADVANCES'`, [t]).then((r) => Number(r.rows[0].held));

test("deposit and refund: AD- receipts, journal, permissions, can't refund more than held; books agree", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    await expectError(c, `select record_patient_advance($1, $2, $3, 'deposit', 100, 0, null, null, null, $4, 'A1', null)`, [x.t, uuid(), x.p, x.desk], /NO_PERMISSION/);
    const d1 = await deposit(c, x, 3000, 2000);
    assert.match(d1.receipt_no, /^AD-\d+$/);
    assert.equal(Number(d1.balance), 5000);
    const d2 = await deposit(c, x, 500, 0, x.cashier);
    assert.equal(Number(d2.balance), 5500, "a cashier can take an advance");
    const key = uuid();
    const once = (await c.query(`select record_patient_advance($1, $2, $3, 'deposit', 100, 0, null, null, null, $4, 'A1', null) r`, [x.t, key, x.p, x.admin])).rows[0].r;
    const again = (await c.query(`select record_patient_advance($1, $2, $3, 'deposit', 100, 0, null, null, null, $4, 'A1', null) r`, [x.t, key, x.p, x.admin])).rows[0].r;
    assert.equal(again.replayed, true); assert.equal(again.receipt_no, once.receipt_no);
    assert.equal(await balance(c, x), 5600);
    await expectError(c, `select record_patient_advance($1, $2, $3, 'refund', 100, 0, null, null, 'Not needed', $4, 'A1', null)`, [x.t, uuid(), x.p, x.cashier], /NO_PERMISSION/);
    await expectError(c, `select record_patient_advance($1, $2, $3, 'refund', 100, 0, null, null, '', $4, 'A1', null)`, [x.t, uuid(), x.p, x.admin], /REASON_REQUIRED/);
    await expectError(c, `select record_patient_advance($1, $2, $3, 'refund', 6000, 0, null, null, 'Too much', $4, 'A1', null)`, [x.t, uuid(), x.p, x.admin], /MORE_THAN_HELD/);
    const rf = (await c.query(`select record_patient_advance($1, $2, $3, 'refund', 600, 0, null, null, 'Operation postponed', $4, 'A1', null) r`, [x.t, uuid(), x.p, x.admin])).rows[0].r;
    assert.equal(Number(rf.amount), -600); assert.equal(Number(rf.balance), 5000);
    await expectError(c, `insert into patient_advances (tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, kind, amount, cash_amount, received_by, posting_id) values ($1, $1, 'x', 'x', $2, 'deposit', 1, 1, $3, $1)`, [x.t, x.p, x.admin], /permission denied/);
    await asOwner(c);
    await expectError(c, `update patient_advances set note = 'changed' where patient_id = $1`, [x.p], /APPEND_ONLY/);
    assert.equal(await advRow(c, x.t), 5000, "the journal holds the same");
    const { rows: [cash] } = await c.query(`select coalesce(sum(debit - credit), 0)::numeric n from ledger_entries where tenant_id = $1 and account_code = 'CASH'`, [x.t]);
    assert.equal(Number(cash.n), 3000 + 500 + 100 - 600);
    assert.deepEqual(await books(c, x), []);
    const au = (await c.query(`select action, reason from audit_log where tenant_id = $1 and action like 'advance.%' order by id`, [x.t])).rows;
    assert.deepEqual(au.map((r) => r.action), ["advance.deposit", "advance.deposit", "advance.deposit", "advance.refund"]);
    assert.equal(au[3].reason, "Operation postponed");
  });
});

test("check-in: the advance pays the fee even where dues aren't allowed; only what it covers", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 0, 0, null, null, $6, 'A1', null)`, [x.t, uuid(), x.p, x.doc, x.svc, x.admin], /PAYMENT_REQUIRED/);
    await deposit(c, x, 200);
    await expectError(c, `select check_in_visit($1, $2, $3, $4, null, $5, 0, 0, 0, null, null, $6, 'A1', null)`, [x.t, uuid(), x.p, x.doc, x.svc, x.admin], /PAYMENT_REQUIRED/);
    const r = await checkIn(c, x, 300);
    assert.deepEqual([Number(r.total), Number(r.paid), Number(r.due), Number(r.from_advance)], [500, 300, 0, 200]);
    assert.equal(await balance(c, x), 0);
    const { rows: pays } = await c.query(`select cash_amount::numeric c, advance_amount::numeric a, receipt_no from payments where tenant_id = $1 order by received_at, receipt_no`, [x.t]);
    assert.deepEqual(pays.map((p) => [Number(p.c), Number(p.a)]), [[300, 0], [0, 200]]);
    assert.equal(Number((await c.query(`select invoice_outstanding($1) n`, [r.invoice_id])).rows[0].n), 0);
    await asOwner(c);
    assert.deepEqual(await books(c, x), []);
  });
});

test("counter sale: the advance pays; with nothing to sell against it, cash is still required", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    const sell = (cash, p = x.p, key = uuid()) => c.query(`select issue_counter_sale($1, $2, $3, $4, null, null, $5, null, $6, 0, null, null, $7, 'A1', null) r`,
      [x.t, key, x.store, p, JSON.stringify([{ kind: "service", service_id: x.dress, qty: 2 }]), cash, x.cashier]).then((r) => r.rows[0].r);
    await deposit(c, x, 1000);
    const s = await sell(0);
    assert.deepEqual([Number(s.total), Number(s.due), Number(s.from_advance)], [500, 0, 500]);
    assert.equal(await balance(c, x), 500);
    await expectError(c, `select issue_counter_sale($1, $2, $3, null, 'Walk-in', null, $4, null, 0, 0, null, null, $5, 'A1', null)`,
      [x.t, uuid(), x.store, JSON.stringify([{ kind: "service", service_id: x.dress, qty: 1 }]), x.cashier], /PATIENT_REQUIRED_FOR_DUE|PAYMENT_REQUIRED/);
    await asOwner(c);
    assert.deepEqual(await books(c, x), []);
  });
});

test("use for dues: oldest bill first, capped by what's held and owed; NO_DUES / NO_ADVANCE", async () => {
  await withTx(async (c) => {
    const x = await clinic(c, { credit: true });
    await asApp(c);
    const v1 = await checkIn(c, x, 0);
    assert.equal(Number(v1.due), 500);
    await expectError(c, `select use_patient_advance($1, $2, $3, null, $4, 'A1', null)`, [x.t, uuid(), x.p, x.admin], /NO_ADVANCE/);
    await deposit(c, x, 800);
    // a deposit made after a bill on credit does not pay it by itself
    assert.equal(Number((await c.query(`select coalesce(sum(outstanding), 0) n from patient_open_bills($1, $2)`, [x.t, x.p])).rows[0].n), 500);
    await expectError(c, `select use_patient_advance($1, $2, $3, 900, $4, 'A1', null)`, [x.t, uuid(), x.p, x.admin], /MORE_THAN_HELD/);
    await expectError(c, `select use_patient_advance($1, $2, $3, null, $4, 'A1', null)`, [x.t, uuid(), x.p, x.desk], /NO_PERMISSION/);
    const key = uuid();
    const u = (await c.query(`select use_patient_advance($1, $2, $3, null, $4, 'A1', null) r`, [x.t, key, x.p, x.cashier])).rows[0].r;
    assert.deepEqual([Number(u.used), Number(u.balance)], [500, 300]);
    assert.equal((await c.query(`select use_patient_advance($1, $2, $3, null, $4, 'A1', null) r`, [x.t, key, x.p, x.cashier])).rows[0].r.replayed, true);
    await expectError(c, `select use_patient_advance($1, $2, $3, null, $4, 'A1', null)`, [x.t, uuid(), x.p, x.admin], /NO_DUES/);
    assert.equal(await balance(c, x), 300);
    await asOwner(c);
    assert.deepEqual(await books(c, x), []);
  });
});

test("void: a bill paid from the advance gives it back to the advance, not as cash", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    await deposit(c, x, 400);
    const r = await checkIn(c, x, 100);
    assert.equal(await balance(c, x), 0);
    await c.query(`select void_invoice($1, $2, $3, 'Wrong doctor', $4, 'A2', now(), null)`, [x.t, uuid(), r.invoice_id, x.admin]);
    assert.equal(await balance(c, x), 400, "the advance is back");
    await asOwner(c);
    const cash = Number((await c.query(`select account_balance($1, 'CASH', 'infinity') n`, [x.t])).rows[0].n);
    assert.equal(cash, 400, "cash: 400 deposit + 100 fee − 100 refunded; the advance part was not paid out");
    assert.equal(await advRow(c, x.t), 400);
    assert.deepEqual(await books(c, x), []);
  });
});

test("reports: held advances in the finance report; the day shows advances apart from collections", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    await deposit(c, x, 1000);
    await checkIn(c, x, 0);
    await asOwner(c);
    const day = (await c.query(`select business_day($1, now()) d`, [x.t])).rows[0].d;
    const fr = (await c.query(`select finance_report($1, $2, $2) r`, [x.t, day])).rows[0].r;
    assert.equal(Number(fr.balances.PATIENT_ADVANCES.closing), 500);
    assert.ok(fr.money.some((m) => m.kind === "patient_advance" && Number(m.cash_in) === 1000));
    const ds = (await c.query(`select daily_summary($1, $2) r`, [x.t, day])).rows[0].r;
    assert.deepEqual([ds.collected, ds.advances_in, ds.advances_used, ds.advances_held].map(Number), [0, 1000, 500, 500]);
  });
});

test("merge: the advance moves with the patient and back on undo", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    const { rows: [dup] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years, phone) values ($1, 'Kamala Shrestha', 'female', 61, '9849000001') returning id`, [x.t]);
    await asApp(c);
    await deposit(c, x, 700, 0, x.admin, dup.id);
    const m = (await c.query(`select merge_patients($1, $2, $3, $4, null) id`, [x.t, x.p, dup.id, x.admin])).rows[0].id;
    assert.equal(await balance(c, x), 700);
    assert.equal(await balance(c, x, dup.id), 0);
    const r = await checkIn(c, x, 0);
    assert.equal(Number(r.from_advance), 500);
    await expectError(c, `select undo_patient_merge($1, $2, $3, null)`, [x.t, m, x.admin], /MERGE_UNDO_ADVANCE_SPENT/);
    await c.query(`select void_invoice($1, $2, $3, 'Merged by mistake', $4, 'A2', now(), null)`, [x.t, uuid(), r.invoice_id, x.admin]);
    await c.query(`select undo_patient_merge($1, $2, $3, null)`, [x.t, m, x.admin]);
    assert.equal(await balance(c, x, dup.id), 700, "the deposit goes back with its record");
    assert.equal(await balance(c, x), 0);
    await asOwner(c);
    assert.deepEqual(await books(c, x), []);
  });
});

test("ISOLATION: another clinic can't take, use or see this patient's advance", async () => {
  await withTx(async (c) => {
    const x = await clinic(c), y = await clinic(c);
    await asApp(c);
    await deposit(c, x, 300);
    await expectError(c, `select record_patient_advance($1, $2, $3, 'deposit', 100, 0, null, null, null, $4, 'A1', null)`, [y.t, uuid(), x.p, y.admin], /PATIENT_NOT_FOUND/);
    await expectError(c, `select use_patient_advance($1, $2, $3, null, $4, 'A1', null)`, [y.t, uuid(), x.p, y.admin], /PATIENT_NOT_FOUND/);
    assert.equal(await balance(c, y, x.p), 0);
    await asOwner(c);
  });
});
