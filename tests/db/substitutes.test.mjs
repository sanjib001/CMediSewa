// Substitutes (D-147): another brand of the same medicine (generic, strength, form; never a
// combination) may be sold or held against a prescription, with a reason. RPCs run as service_role.
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
async function withBrands(c) {
  const x = await counter(c);
  await asApp(c);
  const brand = async (o) => (await save(c, x, PARA({ barcodes: [], ...o }))).rows[0].id;
  const calpol = await brand({ name: "Calpol 500" });                                             // same: Paracetamol 500 mg tablet
  const p650 = await brand({ name: "Dolo 650", strength_value: 650 });                            // other strength
  const syrup = await brand({ name: "Paracip syrup", dosage_form: "syrup", units: [{ name: "bottle", factor: 1, is_base: true }], default_purchase_unit: "bottle", default_sale_unit: "bottle" });
  const combo = await brand({ name: "Cafemol", strength_text: "500 mg + 65 mg" });                // a combination (written strength with +)
  const empty = await brand({ name: "Pacimol 500" });                                             // same, but no stock
  const uc = await units(c, calpol);
  await open(c, x, [{ item_id: calpol, unit_id: uc.tab, qty: 40, batch_no: "CP1", expiry_date: d(300), unit_cost: 1, mrp: 3, sale_price: 3 }], { by: x.admin });
  await asOwner(c);
  const doc = await member(c, x.t);
  const { rows: [e] } = await c.query(`insert into encounters (tenant_id, patient_id, doctor_member_id, status, finalized_at, chief_complaint) values ($1, $2, $3, 'finalized', now(), 'Fever') returning id`, [x.t, x.patient, doc]);
  const { rows: [rx] } = await c.query(`insert into prescriptions (tenant_id, patient_id, encounter_id, doctor_member_id, status) values ($1, $2, $3, $4, 'draft') returning id`, [x.t, x.patient, e.id, doc]);
  const { rows: [ri] } = await c.query(`insert into prescription_items (tenant_id, prescription_id, line_no, item_id, medicine_text, frequency, quantity) values ($1, $2, 1, $3, 'Cetamol 500', '1-1-1', 30) returning id`, [x.t, rx.id, x.para]);
  await c.query(`update prescriptions set status = 'issued', rx_number = 'RX-S0001', issued_at = now() where id = $1`, [rx.id]);
  return { ...x, calpol, p650, syrup, combo, empty, uc, ri: ri.id };
}

test("same medicine: same generic, strength and form, never a combination; substitutes in stock listed", async () => {
  await withTx(async (c) => {
    const x = await withBrands(c);
    await asApp(c);
    const eq = async (b) => (await c.query(`select medicine_equivalent($1, $2, $3) e`, [x.t, x.para, b])).rows[0].e;
    assert.deepEqual([await eq(x.calpol), await eq(x.empty), await eq(x.p650), await eq(x.syrup), await eq(x.combo), await eq(x.amox)], [true, true, false, false, false, false]);
    const subs = (await c.query(`select * from medicine_substitutes($1, $2, $3)`, [x.t, x.para, x.store])).rows;
    assert.deepEqual(subs.map((s) => [s.name, Number(s.available)]), [["Calpol 500", 40]], "only brands with sellable stock, never the item itself");
  });
});

test("prescription: another brand must be the same medicine, with a reason, and it counts as dispensed", async () => {
  await withTx(async (c) => {
    const x = await withBrands(c);
    await asApp(c);
    const SALE = `select issue_counter_sale($1, $2, $3, $4, null, null, $5, null, $6, 0, null, null, $7, 'A1', null)`;
    const line = (item, unit, o = {}) => ({ kind: "item", item_id: item, unit_id: unit, qty: 10, prescription_item_id: x.ri, ...o });
    await expectError(c, SALE, [x.t, uuid(), x.store, x.patient, JSON.stringify([line(x.calpol, x.uc.tab)]), 30, x.pharmacist], /SUBSTITUTION_REASON_REQUIRED/);
    await expectError(c, SALE, [x.t, uuid(), x.store, x.patient, JSON.stringify([line(x.amox, x.ua.tab, { substitution_reason: "Out of stock" })]), 100, x.pharmacist], /NOT_EQUIVALENT/);
    const r = (await sell(c, x, [line(x.calpol, x.uc.tab, { substitution_reason: "Prescribed brand out of stock" })], { patient: x.patient, cash: 30 })).rows[0].r;
    await asOwner(c);
    const { rows: [il] } = await c.query(`select substitution_reason, prescription_item_id from invoice_lines where invoice_id = $1`, [r.invoice_id]);
    assert.deepEqual([il.substitution_reason, il.prescription_item_id], ["Prescribed brand out of stock", x.ri]);
    await asApp(c);
    const q = (await c.query(`select dispensing_queue($1, $2, 'A1') j`, [x.t, x.pharmacist])).rows[0].j.queue.find((y) => y.rx_number === "RX-S0001").items[0];
    assert.deepEqual([Number(q.dispensed_base), Number(q.remaining)], [10, 20], "10 given as Calpol, 20 left");
    // the prescribed brand itself needs no reason; a walk-in sale of another brand needs none either
    await sell(c, x, [line(x.para, x.u.tab, { qty: 5 })], { patient: x.patient, cash: 10 });
    await sell(c, x, [{ kind: "item", item_id: x.calpol, unit_id: x.uc.tab, qty: 2 }], { cash: 6, name: "Walk-in" });
  });
});

test("hold for a prescription: the same rule, and the reason travels to the bill", async () => {
  await withTx(async (c) => {
    const x = await withBrands(c);
    await asApp(c);
    const HOLD = `select create_stock_hold($1, $2, $3, $4, null, null, 48, null, $5, $6, 'A1') r`;
    const lines = (o = {}) => JSON.stringify([{ item_id: x.calpol, unit_id: x.uc.tab, qty: 6, prescription_item_id: x.ri, ...o }]);
    await expectError(c, HOLD, [x.t, uuid(), x.store, x.patient, lines(), x.pharmacist], /SUBSTITUTION_REASON_REQUIRED/);
    const h = (await c.query(HOLD, [x.t, uuid(), x.store, x.patient, lines({ substitution_reason: "Patient's usual brand" }), x.pharmacist])).rows[0].r;
    await asOwner(c);
    const { rows: [hl] } = await c.query(`select id, substitution_reason from stock_hold_lines where hold_id = $1`, [h.hold_id]);
    assert.equal(hl.substitution_reason, "Patient's usual brand");
    await asApp(c);
    const r = (await sell(c, x, [{ kind: "item", item_id: x.calpol, unit_id: x.uc.tab, qty: 6, prescription_item_id: x.ri, hold_line_id: hl.id, substitution_reason: hl.substitution_reason }],
      { patient: x.patient, cash: 18 })).rows[0].r;
    assert.equal(Number(r.total), 18);
  });
});
