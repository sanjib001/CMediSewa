// B7a pharmacy counter: FEFO across lots at lot prices, exact COGS, Rx rules (internal / external),
// controlled items blocked, discounts, dues, the pharmacist's dispensing queue (C7), isolation.
// access, isolation. RPCs run as service_role, like the app.
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
const acct = async (c, t) => Object.fromEntries((await c.query(`select account_code a, sum(debit - credit)::numeric n from ledger_entries where tenant_id = $1 group by 1`, [t])).rows.map((r) => [r.a, Number(r.n)]));

test("OTC sale: earliest expiry first across lots at each lot's own price; exact cost; one bill series; retry safe", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    const before = await acct(c, x.t);
    await asApp(c);
    const key = uuid();
    const r = (await sell(c, x, [{ kind: "item", item_id: x.para, unit_id: x.u.strip, qty: 3 }], { key, cash: 65, name: "Walk-in" })).rows[0].r;
    assert.equal(Number(r.total), 65, "20 tabs at Rs. 2 (soonest lot) + 10 at Rs. 2.5");
    assert.equal((await sell(c, x, [{ kind: "item", item_id: x.para, unit_id: x.u.strip, qty: 3 }], { key, cash: 65 })).rows[0].r.replayed, true, "a double tap returns the first bill");
    await asOwner(c);
    const al = (await c.query(`select ib.batch_no, a.base_qty::numeric q, a.unit_price_base::numeric p from invoice_line_allocations a join item_batches ib on ib.id = a.batch_id
                               join invoice_lines l on l.id = a.invoice_line_id where l.invoice_id = $1 order by ib.expiry_date`, [r.invoice_id])).rows.map((x) => [x.batch_no, Number(x.q), Number(x.p)]);
    assert.deepEqual(al, [["SOON", 20, 2], ["LATE", 10, 2.5]], "one line, two lots; the expired lot was never touched");
    const { rows: [line] } = await c.query(`select cost_total::numeric c, unit_price::numeric up from invoice_lines where invoice_id = $1`, [r.invoice_id]);
    assert.deepEqual([Number(line.c), Number(line.up)], [32, 21.67], "COGS 20×1 + 10×1.2; Rs. 21.67 per strip on the bill");
    const after = await acct(c, x.t);
    const delta = (k) => Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 100) / 100;
    assert.deepEqual([delta("CASH"), delta("REV_PHARMACY"), delta("COGS"), delta("INVENTORY"), delta("AR_PATIENTS")], [65, -65, 32, -32, 0]);
    const { rows: [{ q }] } = await c.query(`select sum(qty_on_hand)::numeric q from stock_balances b join item_batches ib on ib.id = b.batch_id where ib.item_id = $1 and ib.batch_no = 'SOON'`, [x.para]);
    assert.equal(Number(q), 0);
  });
});

test("counter rules: controlled blocked, prescription-only needs an Rx, discounts, dues, payments, stores", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    await asApp(c);
    const bad = (lines, re, o = {}) => expectError(c, `select issue_counter_sale($1, $2, $3, $4, null, null, $5, $6, $7, 0, null, null, $8, 'A1', null)`,
      [x.t, uuid(), o.store ?? x.store, o.patient ?? null, JSON.stringify(lines), o.ext ? JSON.stringify(o.ext) : null, o.cash ?? 0, o.by ?? x.pharmacist], re);
    await bad([{ kind: "item", item_id: x.tram, unit_id: x.ut.tab, qty: 1 }], /CONTROLLED_BLOCKED/, { cash: 8 });
    await bad([{ kind: "item", item_id: x.amox, unit_id: x.ua.tab, qty: 10 }], /RX_REQUIRED/, { cash: 100 });
    await bad([{ kind: "item", item_id: x.amox, unit_id: x.ua.tab, qty: 10 }], /NO_DISPENSING_RIGHT/, { cash: 100, by: x.admin, ext: { prescriber_name: "Dr. Outside" } });
    const r = (await sell(c, x, [{ kind: "item", item_id: x.amox, unit_id: x.ua.tab, qty: 10 }], { patient: x.patient, cash: 100, ext: { prescriber_name: "Dr. Outside", prescriber_reg_no: "NMC 999", facility: "Bir Hospital" } })).rows[0].r;
    await asOwner(c);
    assert.ok((await c.query(`select external_prescription_id from invoices where id = $1`, [r.invoice_id])).rows[0].external_prescription_id, "outside prescription recorded and linked");
    await asApp(c);
    await bad([{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 500 }], /INSUFFICIENT_STOCK/, { cash: 1000 });
    await bad([{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 10 }], /OVERPAYMENT/, { cash: 999 });
    await bad([{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 10 }], /PATIENT_REQUIRED_FOR_DUE/, { cash: 5 });
    await bad([{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 10 }], /PAYMENT_REQUIRED/, { cash: 5, patient: x.patient });
    await bad([{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 10, discount_pct: 20 }], /DISCOUNT_NEEDS_APPROVAL/, { cash: 16 });
    await bad([{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 1 }], /STORE_NOT_SELLABLE/, { store: x.quarantine, cash: 2, by: x.admin });
    const { rows: [late] } = await c.query(`select id from item_batches where item_id = $1 and batch_no = 'LATE'`, [x.para]);
    const o = (await sell(c, x, [{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 4, batch_id: late.id }], { cash: 10 })).rows[0].r;
    assert.equal(Number(o.total), 10, "chosen lot (override_batch) at its own price");
    const { rows: [old] } = await c.query(`select id from item_batches where item_id = $1 and batch_no = 'OLD'`, [x.para]);
    await bad([{ kind: "item", item_id: x.para, unit_id: x.u.tab, qty: 1, batch_id: old.id }], /LOT_NOT_SELLABLE/, { cash: 2 });
    await asOwner(c);
  });
});

test("dispensing queue (C7): only for pharmacists, only Rx items + allergies; dispensed items leave the queue", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    const doc = await member(c, x.t);
    await c.query(`insert into patient_allergies (tenant_id, patient_id, allergen, recorded_by) values ($1, $2, 'Penicillin', $3)`, [x.t, x.patient, x.admin]);
    const { rows: [e] } = await c.query(`insert into encounters (tenant_id, patient_id, doctor_member_id, status, finalized_at, chief_complaint) values ($1, $2, $3, 'finalized', now(), 'Cough') returning id`, [x.t, x.patient, doc]);
    const { rows: [rx] } = await c.query(`insert into prescriptions (tenant_id, patient_id, encounter_id, doctor_member_id, status) values ($1, $2, $3, $4, 'draft') returning id`, [x.t, x.patient, e.id, doc]);
    const { rows: [ri1] } = await c.query(`insert into prescription_items (tenant_id, prescription_id, line_no, medicine_text, dose, frequency, quantity) values ($1, $2, 1, 'Amoxicillin 500', '1 cap', '1-1-1', 15) returning id`, [x.t, rx.id]);
    await c.query(`insert into prescription_items (tenant_id, prescription_id, line_no, medicine_text, frequency, quantity) values ($1, $2, 2, 'Paracetamol 500', 'SOS', 10)`, [x.t, rx.id]);
    await c.query(`update prescriptions set status = 'issued', rx_number = 'RX-000001', issued_at = now() where id = $1`, [rx.id]);
    await asApp(c);
    const q = (await c.query(`select dispensing_queue($1, $2, 'A1') j`, [x.t, x.pharmacist])).rows[0].j;
    assert.equal(q.queue.length, 1);
    assert.deepEqual(q.queue[0].allergies, ["Penicillin"]);
    assert.equal(q.queue[0].items.length, 2);
    assert.equal(q.queue[0].chief_complaint, undefined, "no notes, no diagnosis: Rx items and allergies only");
    assert.equal((await c.query(`select dispensing_queue($1, $2, 'A1') j`, [x.t, x.admin])).rows[0].j.error, "NO_DISPENSING_RIGHT", "a clinic admin isn't a pharmacist");
    await sell(c, x, [{ kind: "item", item_id: x.amox, unit_id: x.ua.tab, qty: 15, prescription_item_id: ri1.id }], { patient: x.patient, cash: 150 });
    const q2 = (await c.query(`select dispensing_queue($1, $2, 'A1') j`, [x.t, x.pharmacist])).rows[0].j;
    assert.deepEqual(q2.queue[0].items.map((i) => i.dispensed), [true, false], "partly dispensed: stays in the queue");
    await expectError(c, `select issue_counter_sale($1, $2, $3, null, null, null, $4, null, 150, 0, null, null, $5, 'A1', null)`,
      [x.t, uuid(), x.store, JSON.stringify([{ kind: "item", item_id: x.amox, unit_id: x.ua.tab, qty: 15, prescription_item_id: ri1.id }]), x.pharmacist], /RX_NOT_VALID/);
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from audit_log where tenant_id = $1 and action = 'pharmacy.queue_read'`, [x.t])).rows[0].n, 3, "every queue read is logged");
  });
});

test("ISOLATION: no sale can take another clinic's items, stores or prescriptions", async () => {
  await withTx(async (c) => {
    const a = await counter(c), b = await counter(c);
    await asApp(c);
    await expectError(c, `select issue_counter_sale($1, $2, $3, null, null, null, $4, null, 10, 0, null, null, $5, 'A1', null)`,
      [a.t, uuid(), a.store, JSON.stringify([{ kind: "item", item_id: b.para, unit_id: b.u.tab, qty: 1 }]), a.pharmacist], /ITEM_NOT_FOUND/);
    await expectError(c, `select issue_counter_sale($1, $2, $3, null, null, null, $4, null, 10, 0, null, null, $5, 'A1', null)`,
      [a.t, uuid(), b.store, JSON.stringify([{ kind: "item", item_id: a.para, unit_id: a.u.tab, qty: 1 }]), a.pharmacist], /NO_STORE_ACCESS|STORE_NOT_SELLABLE/);
    await expectError(c, `select issue_counter_sale($1, $2, $3, $4, null, null, $5, null, 10, 0, null, null, $6, 'A1', null)`,
      [a.t, uuid(), a.store, b.patient, JSON.stringify([{ kind: "item", item_id: a.para, unit_id: a.u.tab, qty: 1 }]), a.pharmacist], /PATIENT_NOT_FOUND/);
    await asOwner(c);
  });
});
