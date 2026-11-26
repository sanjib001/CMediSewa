// M-45 stock holds (D-145): lots kept aside for a patient or customer, reserved so nobody else
// sells them, collected as an ordinary counter sale, released by hand, by time, or when a lot
// stops being sellable. RPCs run as service_role, like the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

async function authUser(c) {
  const id = uuid();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`, [id, `inv-${id.slice(0, 8)}@example.invalid`]);
  return id;
}
async function member(c, t, admin = false) {
  const { rows: [m] } = await c.query(`insert into tenant_members (tenant_id, auth_user_id, membership_role, display_name, email) values ($1, $2, $3, 'Staff', $4) returning id`,
    [t, await authUser(c), admin ? "tenant_admin" : "tenant_member", `m-${uuid().slice(0, 8)}@example.invalid`]);
  return m.id;
}
async function clinic(c) {
  const t = await makeTenant(c);
  await c.query(`update tenants set status = 'active' where id = $1`, [t]);
  const { rows: [bp] } = await c.query(`insert into billing_profiles (tenant_id, name, legal_name, is_default) values ($1, 'C', 'C Ltd', true) returning id`, [t]);
  await c.query(`insert into tenant_settings (tenant_id, default_billing_profile_id) values ($1, $2)`, [t, bp.id]);
  const { rows: [ph] } = await c.query(`insert into stores (tenant_id, code, name, kind, billing_profile_id, is_sellable, is_dispensing, is_receiving) values ($1, 'PHARM', 'Pharmacy', 'pharmacy', $2, true, true, true) returning id`, [t, bp.id]);
  const { rows: [q] } = await c.query(`insert into stores (tenant_id, code, name, kind, billing_profile_id, is_sellable, is_dispensing, is_receiving) values ($1, 'QUAR', 'Quarantine', 'quarantine', $2, false, false, false) returning id`, [t, bp.id]);
  const admin = await member(c, t, true), pharmacist = await member(c, t), other = await member(c, t);
  await c.query(`insert into store_members (tenant_id, store_id, member_id, access) values ($1, $2, $3, 'manage')`, [t, ph.id, pharmacist]);
  return { t, store: ph.id, quarantine: q.id, admin, pharmacist, other };
}
const PARA = (o = {}) => ({
  item_type: "medicine", name: "Cetamol 500", generic: "Paracetamol", strength_value: 500, strength_unit: "mg", dosage_form: "tablet", route: "oral",
  schedule_class: "otc", manufacturer: "Nepal Pharmaceuticals", category: "Analgesics", reorder_level: 200, min_stock_level: 50,
  units: [{ name: "tab", factor: 1, is_base: true }, { name: "strip", factor: 10 }, { name: "box", factor: 100 }],
  barcodes: [{ barcode: "8901234500011", unit: "strip" }], default_purchase_unit: "box", default_sale_unit: "strip", ...o,
});
const asApp = (c) => c.query(`set role service_role`);
const asOwner = (c) => c.query(`reset role`);
const save = (c, x, d, id = null, by = x.admin) => c.query(`select save_item($1, $2, $3, $4) id`, [x.t, id, JSON.stringify(d), by]);
const units = async (c, item) => Object.fromEntries((await c.query(`select name, id from item_units where item_id = $1`, [item])).rows.map((r) => [r.name, r.id]));
const open = (c, x, lines, o = {}) => c.query(`select post_opening_stock($1, $2, $3, $4, null, $5, $6, null) id`,
  [x.t, o.key ?? uuid(), o.store ?? x.store, JSON.stringify(lines), o.by ?? x.pharmacist, o.level ?? "A2"]);


// ── B7a pharmacy counter ──
const d = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const PHARMACY_KEYS = ["pharmacy_sell", "dispense_prescription", "sell_prescription_only", "override_batch", "view_billing", "manage_billing", "view_stock"];
async function counter(c) {
  const x = await clinic(c);
  // the pharmacist: Pharmacy keys + a VERIFIED pharmacist registration (clinical/dispensing keys need it)
  const { rows: [r] } = await c.query(`insert into tenant_roles (tenant_id, name, permissions) values ($1, 'Counter', $2) returning id`, [x.t, PHARMACY_KEYS]);
  await c.query(`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [x.t, x.pharmacist, r.id]);
  const { rows: [cr] } = await c.query(`insert into member_credentials (tenant_id, member_id, profession, council, registration_no) values ($1, $2, 'pharmacist', 'NPC', $3) returning id`, [x.t, x.pharmacist, `P-${uuid().slice(0, 6)}`]);
  await c.query(`select verify_member_credential($1, $2, null)`, [cr.id, x.admin]);
  await asApp(c);
  const { rows: [{ id: para }] } = await save(c, x, PARA({ barcodes: [] }));               // OTC
  const { rows: [{ id: amox }] } = await save(c, x, PARA({ name: "Amoxil 500", generic: "Amoxicillin", schedule_class: "prescription_only", barcodes: [] }));
  const { rows: [{ id: tram }] } = await save(c, x, PARA({ name: "Tramadol 50", generic: "Tramadol", schedule_class: "controlled", barcodes: [] }));
  const u = await units(c, para), ua = await units(c, amox), ut = await units(c, tram);
  await open(c, x, [
    { item_id: para, unit_id: u.tab, qty: 20, batch_no: "SOON", expiry_date: d(200), unit_cost: 1, mrp: 2, sale_price: 2 },
    { item_id: para, unit_id: u.tab, qty: 50, batch_no: "LATE", expiry_date: d(600), unit_cost: 1.2, mrp: 2.5, sale_price: 2.5 },
    { item_id: para, unit_id: u.tab, qty: 99, batch_no: "OLD", expiry_date: d(-3), unit_cost: 1, mrp: 2 },
    { item_id: amox, unit_id: ua.tab, qty: 30, batch_no: "AX1", expiry_date: d(300), unit_cost: 6, mrp: 10 },
    { item_id: tram, unit_id: ut.tab, qty: 10, batch_no: "TR1", expiry_date: d(300), unit_cost: 5, mrp: 8 },
  ], { by: x.admin });
  await asOwner(c);
  const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years, phone) values ($1, 'Kamala Rai', 'female', 52, '9841000001') returning id`, [x.t]);
  return { ...x, para, amox, tram, u, ua, ut, patient: p.id };
}
const sell = (c, x, lines, o = {}) => c.query(
  `select issue_counter_sale($1, $2, $3, $4, $5, null, $6, $7, $8, $9, $10, null, $11, $12, null) r`,
  [x.t, o.key ?? uuid(), o.store ?? x.store, o.patient ?? null, o.name ?? null, JSON.stringify(lines), o.ext ? JSON.stringify(o.ext) : null,
   o.cash ?? 0, o.online ?? 0, o.channel ?? null, o.by ?? x.pharmacist, o.level ?? "A1"]);
const hold = (c, x, lines, o = {}) => c.query(`select create_stock_hold($1, $2, $3, $4, $5, $6, $7, null, $8, $9, $10) r`,
  [x.t, o.key ?? uuid(), o.store ?? x.store, o.patient === undefined ? x.patient : o.patient, o.name ?? null, o.phone ?? null, o.hours ?? 48,
   JSON.stringify(lines), o.by ?? x.pharmacist, o.level ?? "A1"]).then((q) => q.rows[0].r);
const reserved = async (c, x) => Object.fromEntries((await c.query(`select ib.batch_no, b.qty_reserved::numeric r from stock_balances b join item_batches ib on ib.id = b.batch_id
  where b.store_id = $1 and b.item_id = $2`, [x.store, x.para])).rows.map((r) => [r.batch_no, Number(r.r)]));
const holdLines = async (c, id) => (await c.query(`select l.id, ib.batch_no, l.qty_base::numeric q from stock_hold_lines l join item_batches ib on ib.id = l.batch_id where hold_id = $1 order by line_no`, [id])).rows;
const status = async (c, id) => (await c.query(`select status, end_reason, invoice_id from stock_holds where id = $1`, [id])).rows[0];
const lot = async (c, x, no) => (await c.query(`select id from item_batches where tenant_id = $1 and batch_no = $2`, [x.t, no])).rows[0].id;
const HOLD_SQL = `select create_stock_hold($1, $2, $3, null, $4, null, $5, null, $6, $7, 'A1')`;

test("hold: lots kept aside earliest expiry first; nobody else can sell them; a retry returns the same hold", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    await asApp(c);
    const key = uuid();
    const h = await hold(c, x, [{ item_id: x.para, unit_id: x.u.strip, qty: 3 }], { key });
    assert.match(h.hold_no, /^HD-\d{5}$/);
    assert.equal((await hold(c, x, [{ item_id: x.para, unit_id: x.u.strip, qty: 3 }], { key })).replayed, true);
    await asOwner(c);
    assert.deepEqual((await holdLines(c, h.hold_id)).map((l) => [l.batch_no, Number(l.q)]), [["SOON", 20], ["LATE", 10]]);
    assert.deepEqual(await reserved(c, x), { SOON: 20, LATE: 10, OLD: 0 });
    const soon = await lot(c, x, "SOON");
    await asApp(c);
    const SALE = `select issue_counter_sale($1, $2, $3, null, 'Walk-in', null, $4, null, $5, 0, null, null, $6, 'A1', null)`;
    await expectError(c, SALE, [x.t, uuid(), x.store, JSON.stringify([{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 50 }]), 125, x.pharmacist], /INSUFFICIENT_STOCK/);
    const r = (await sell(c, x, [{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 40 }], { cash: 100, name: "Walk-in" })).rows[0].r;
    assert.equal(Number(r.total), 100, "the 40 not held, all from LATE at Rs. 2.5");
    // a chosen lot can't reach held stock either
    await expectError(c, SALE, [x.t, uuid(), x.store, JSON.stringify([{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 1, batch_id: soon }]), 2, x.pharmacist], /INSUFFICIENT_STOCK/);
    const one = JSON.stringify([{ item_id: x.para, unit_id: x.u.tab, qty: 1 }]);
    await expectError(c, HOLD_SQL, [x.t, uuid(), x.store, "", 48, one, x.pharmacist], /NAME_REQUIRED/);
    await expectError(c, HOLD_SQL, [x.t, uuid(), x.store, "Ram", 48, JSON.stringify([{ item_id: x.tram, unit_id: x.ut.tab, qty: 1 }]), x.pharmacist], /CONTROLLED_BLOCKED/);
    await expectError(c, HOLD_SQL, [x.t, uuid(), x.store, "Ram", 400, one, x.pharmacist], /BAD_HOURS/);
    await expectError(c, HOLD_SQL, [x.t, uuid(), x.store, "Ram", 48, JSON.stringify([{ item_id: x.para, unit_id: x.u.tab, qty: 11 }]), x.pharmacist], /INSUFFICIENT_STOCK/);
    await expectError(c, HOLD_SQL, [x.t, uuid(), x.store, "Ram", 48, one, x.other], /NO_PERMISSION/);
  });
});

test("collect: the bill sells from the held lots, up to what was held, for that patient only; the rest goes back", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    await asApp(c);
    const h = await hold(c, x, [{ item_id: x.para, unit_id: x.u.strip, qty: 3 }]);
    await asOwner(c);
    const [soon, late] = await holdLines(c, h.hold_id);
    const { rows: [p2] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years) values ($1, 'Someone Else', 'male', 30) returning id`, [x.t]);
    await asApp(c);
    const line = (hl, qty) => ({ kind: "item", item_id: x.para, unit_id: x.u.tab, qty, hold_line_id: hl.id });
    const SALE = `select issue_counter_sale($1, $2, $3, $4, null, null, $5, null, $6, 0, null, null, $7, 'A1', null)`;
    await expectError(c, SALE, [x.t, uuid(), x.store, p2.id, JSON.stringify([line(soon, 20)]), 40, x.pharmacist], /HOLD_NOT_VALID/);
    await expectError(c, SALE, [x.t, uuid(), x.store, x.patient, JSON.stringify([line(soon, 21)]), 42, x.pharmacist], /MORE_THAN_HELD/);
    const r = (await sell(c, x, [line(soon, 20), line(late, 5)], { patient: x.patient, cash: 52.5 })).rows[0].r;
    assert.equal(Number(r.total), 52.5, "20 × 2 from SOON + 5 × 2.5 from LATE");
    await asOwner(c);
    const s = await status(c, h.hold_id);
    assert.deepEqual([s.status, s.invoice_id, s.end_reason], ["collected", r.invoice_id, "Collected in part; the rest went back to the shelf"]);
    assert.deepEqual(await reserved(c, x), { SOON: 0, LATE: 0, OLD: 0 });
    const al = (await c.query(`select ib.batch_no, a.base_qty::numeric q from invoice_line_allocations a join item_batches ib on ib.id = a.batch_id join invoice_lines l on l.id = a.invoice_line_id
                               where l.invoice_id = $1 order by ib.batch_no desc`, [r.invoice_id])).rows.map((y) => [y.batch_no, Number(y.q)]);
    assert.deepEqual(al, [["SOON", 20], ["LATE", 5]]);
    await asApp(c);
    await expectError(c, SALE, [x.t, uuid(), x.store, x.patient, JSON.stringify([line(late, 1)]), 2.5, x.pharmacist], /HOLD_NOT_VALID/);
    const { rows: [{ r: rec }] } = await c.query(`select reconcile_stock_balances($1) r`, [x.t]);
    assert.equal(rec.mismatches, 0, "the stock ledger still matches");
  });
});

test("release by hand, by time, or when a lot is blocked; the nightly job rebuilds what is reserved", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    await asApp(c);
    const a = await hold(c, x, [{ item_id: x.para, unit_id: x.u.tab, qty: 5 }]);
    await expectError(c, `select release_stock_hold($1, $2, '', $3, 'A1')`, [x.t, a.hold_id, x.pharmacist], /REASON_REQUIRED/);
    await c.query(`select release_stock_hold($1, $2, 'Patient called: not coming', $3, 'A1')`, [x.t, a.hold_id, x.pharmacist]);
    await expectError(c, `select release_stock_hold($1, $2, 'again', $3, 'A1')`, [x.t, a.hold_id, x.pharmacist], /HOLD_NOT_HELD/);
    await asOwner(c);
    assert.equal((await status(c, a.hold_id)).status, "released");
    assert.deepEqual(await reserved(c, x), { SOON: 0, LATE: 0, OLD: 0 });

    await asApp(c);
    const b = await hold(c, x, [{ item_id: x.para, unit_id: x.u.tab, qty: 15 }], { patient: null, name: "Phone order: Hari", phone: "9800000000", hours: 1 });
    await asOwner(c);
    await c.query(`update stock_holds set expires_at = now() - interval '1 minute' where id = $1`, [b.hold_id]);
    assert.equal((await reserved(c, x)).SOON, 15, "still reserved until something looks");
    await asApp(c);
    await sell(c, x, [{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 1 }], { cash: 2, name: "Walk-in" });
    await asOwner(c);
    assert.deepEqual([(await status(c, b.hold_id)).status, (await reserved(c, x)).SOON], ["expired", 0], "the next sale ended it first");

    await asApp(c);
    const d2 = await hold(c, x, [{ item_id: x.para, unit_id: x.u.tab, qty: 25 }]);   // 19 SOON + 6 LATE
    await asOwner(c);
    const soon = await lot(c, x, "SOON");
    await asApp(c);
    await c.query(`select set_batch_status($1, $2, $3, 'blocked', 'Damaged packs found', 'A2')`, [x.t, x.admin, soon]);
    await asOwner(c);
    const s = await status(c, d2.hold_id);
    assert.deepEqual([s.status, s.end_reason], ["released", "Batch SOON was blocked, so the hold was released"]);
    assert.deepEqual(await reserved(c, x), { SOON: 0, LATE: 0, OLD: 0 });

    // the nightly job: ends what ran out, and rebuilds reserved quantities that drifted
    await asApp(c);
    const e = await hold(c, x, [{ item_id: x.para, unit_id: x.u.tab, qty: 4 }]);
    const f = await hold(c, x, [{ item_id: x.para, unit_id: x.u.tab, qty: 3 }]);
    await asOwner(c);
    await c.query(`update stock_holds set expires_at = now() - interval '1 minute' where id = $1`, [e.hold_id]);
    await c.query(`update stock_balances set qty_reserved = 0 where tenant_id = $1`, [x.t]);
    await asApp(c);
    const j = (await c.query(`select run_daily_jobs($1) j`, [x.t])).rows[0].j;
    assert.equal(j.holds_expired, 1);
    await asOwner(c);
    assert.equal((await reserved(c, x)).LATE, 3, "rebuilt from the hold still held");
    assert.equal((await status(c, f.hold_id)).status, "held");
  });
});

test("ISOLATION: another clinic can't release, use or hold from this clinic's stock", async () => {
  await withTx(async (c) => {
    const x = await counter(c), y = await counter(c);
    await asApp(c);
    const h = await hold(c, x, [{ item_id: x.para, unit_id: x.u.tab, qty: 2 }]);
    await expectError(c, `select release_stock_hold($1, $2, 'not mine', $3, 'A1')`, [y.t, h.hold_id, y.pharmacist], /HOLD_NOT_FOUND/);
    await expectError(c, HOLD_SQL, [y.t, uuid(), x.store, "Ram", 48, JSON.stringify([{ item_id: x.para, unit_id: x.u.tab, qty: 1 }]), y.pharmacist], /NO_STORE_ACCESS|STORE_NOT_SELLABLE/);
    await asOwner(c);
    const [hl] = await holdLines(c, h.hold_id);
    await asApp(c);
    await expectError(c, `select issue_counter_sale($1, $2, $3, null, 'X', null, $4, null, 2, 0, null, null, $5, 'A1', null)`,
      [y.t, uuid(), y.store, JSON.stringify([{ kind: "item", item_id: y.para, unit_id: y.u.tab, qty: 1, hold_line_id: hl.id }]), y.pharmacist], /HOLD_NOT_VALID/);
  });
});
