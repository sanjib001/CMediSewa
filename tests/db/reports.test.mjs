// B8b reports: stock report identity and chaining, batch history, expiry windows, sales register,
// item sales net of returns, cash book, isolation. RPCs run as service_role, like the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, makeTenant, uuid } from "./helpers.mjs";

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


// ── B8b reports ──
const day = async (c, t) => (await c.query(`select stock_today($1)::text d`, [t])).rows[0].d;
const N = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" && !k.endsWith("_no") && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
async function soldAndReturned(c, x) {
  await asApp(c);
  const r = (await sell(c, x, [{ kind: "item", item_id: x.para, unit_id: x.u.strip, qty: 3 }], { cash: 65 })).rows[0].r;
  await asOwner(c);
  const { rows: [a] } = await c.query(`select a.id from invoice_line_allocations a join invoice_lines l on l.id = a.invoice_line_id join item_batches ib on ib.id = a.batch_id where l.invoice_id = $1 and ib.batch_no = 'LATE'`, [r.invoice_id]);
  await asApp(c);
  await c.query(`select post_sale_return($1, $2, $3, 'refund_cash', null, 'Changed mind', $4, $5, 'A2', now(), null)`, [x.t, uuid(), r.invoice_id, JSON.stringify([{ allocation_id: a.id, qty_base: 4, restock: "sellable" }]), x.admin]);
  return r;
}

test("stock report: opening + received − sold − other out = closing, at lot cost; periods chain", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    await soldAndReturned(c, x);
    const d = await day(c, x.t);
    const rows = (await c.query(`select * from stock_report($1, null, $2, $2)`, [x.t, d])).rows.map(N);
    for (const r of rows) assert.equal(Math.round((r.opening_qty + r.received_qty - r.sold_qty - r.other_out_qty) * 1000) / 1000, r.closing_qty, `${r.item} adds up`);
    const para = rows.find((r) => r.item_id === x.para);
    assert.deepEqual([para.received_qty, para.sold_qty, para.closing_qty, para.sold_cost], [169, 26, 143, 27.2], "30 sold, 4 back; cost 32 − 4.8");
    const { rows: [{ v }] } = await c.query(`select sum(b.qty_on_hand * ib.unit_cost_base)::numeric v from stock_balances b join item_batches ib on ib.id = b.batch_id where b.tenant_id = $1`, [x.t]);
    assert.equal(Math.round(rows.reduce((s, r) => s + r.closing_value, 0) * 100) / 100, Math.round(Number(v) * 100) / 100, "closing value = what's on the shelves");
    const prev = (await c.query(`select * from stock_report($1, null, ($2::date - 10), ($2::date - 1))`, [x.t, d])).rows;
    assert.equal(prev.length, 0, "nothing existed before today");
    const store = (await c.query(`select * from stock_report($1, $2, $3, $3)`, [x.t, x.quarantine, d])).rows;
    assert.equal(store.length, 0, "one store at a time");
    await asOwner(c);
  });
});

test("batch history, expiry windows, sales register, item sales net of returns, cash book", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    const r = await soldAndReturned(c, x);
    const d = await day(c, x.t);
    await asOwner(c);
    const { rows: [late] } = await c.query(`select id from item_batches where item_id = $1 and batch_no = 'LATE'`, [x.para]);
    await asApp(c);
    const h = (await c.query(`select kind, qty_base, balance from batch_history($1, $2) b(occurred_at, store, kind, qty_base, store_balance, balance, doc_type, reason, by_name, unit_cost)`, [x.t, late.id])).rows;
    assert.deepEqual(h.map((m) => [m.kind, Number(m.qty_base), Number(m.balance)]), [["opening", 50, 50], ["sale", -10, 40], ["sale_return", 4, 44]]);
    const e90 = (await c.query(`select batch_no, days_left from expiry_report($1, null, 90)`, [x.t])).rows;
    assert.deepEqual(e90.map((e) => e.batch_no), ["OLD"], "only the expired lot within 90 days");
    assert.ok(e90[0].days_left < 0);
    const e365 = (await c.query(`select batch_no from expiry_report($1, null, 365)`, [x.t])).rows.map((e) => e.batch_no);
    assert.deepEqual(e365.sort(), ["AX1", "OLD", "TR1"], "a year ahead adds the 300-day lots; SOON (200 days) is sold out, LATE (600 days) is too far");
    const sr = (await c.query(`select * from sales_register($1, null, $2, $2)`, [x.t, d])).rows.map(N);
    assert.equal(sr.length, 1);
    assert.deepEqual([sr[0].total, sr[0].returned, sr[0].paid, sr[0].outstanding], [65, 10, 55, 0], "refund nets the payment");
    const is = (await c.query(`select * from item_sales($1, null, $2, $2)`, [x.t, d])).rows.map(N);
    assert.deepEqual([is[0].qty, is[0].revenue, is[0].cost, is[0].margin, is[0].bills], [26, 55, 27.2, 27.8, 1]);
    const cb = (await c.query(`select cash_in, cash_out, balance from cash_book($1, $2)`, [x.t, d])).rows.map(N);
    assert.deepEqual(cb.map((e) => [e.cash_in, e.cash_out, e.balance]), [[65, 0, 65], [0, 10, 55]]);
    assert.equal(r.invoice_no, sr[0].invoice_no);
    await asOwner(c);
  });
});

test("ISOLATION: reports never show another clinic's stock, bills or batches", async () => {
  await withTx(async (c) => {
    const a = await counter(c), b = await counter(c);
    await soldAndReturned(c, b);
    const d = await day(c, a.t);
    await asOwner(c);
    const { rows: [bl] } = await c.query(`select id from item_batches where tenant_id = $1 limit 1`, [b.t]);
    await asApp(c);
    assert.ok((await c.query(`select item_id from stock_report($1, null, $2, $2)`, [a.t, d])).rows.every((r) => [a.para, a.amox, a.tram].includes(r.item_id)));
    assert.equal((await c.query(`select * from batch_history($1, $2)`, [a.t, bl.id])).rows.length, 0);
    assert.equal((await c.query(`select * from sales_register($1, null, $2, $2)`, [a.t, d])).rows.length, 0);
    assert.equal((await c.query(`select * from item_sales($1, null, $2, $2)`, [a.t, d])).rows.length, 0);
    assert.equal((await c.query(`select * from cash_book($1, $2)`, [a.t, d])).rows.length, 0);
    await asOwner(c);
  });
});
