// B6a purchasing: vendor bills into new lots (free goods, discounts, VAT), duplicate bills, payments FIFO
// with advances, payable = journal = documents, void rules, isolation. RPCs run as service_role.
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


// ── B6a purchasing ──
const d = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const acct = async (c, t, vendor = null) => Object.fromEntries((await c.query(
  `select account_code a, sum(debit - credit)::numeric n from ledger_entries where tenant_id = $1 and ($2::uuid is null or vendor_id = $2) group by 1`, [t, vendor])).rows.map((r) => [r.a, Number(r.n)]));
async function setup(c) {
  const x = await clinic(c);
  await asApp(c);
  const { rows: [{ id: item }] } = await save(c, x, PARA({ barcodes: [] }));
  const u = await units(c, item);
  const vendor = (await c.query(`select save_vendor($1, null, $2, $3) id`, [x.t, JSON.stringify({ name: "Himalayan Pharma Distributors", pan_vat_no: "301234567", phone: "01-4440000" }), x.admin])).rows[0].id;
  const vendor2 = (await c.query(`select save_vendor($1, null, $2, $3) id`, [x.t, JSON.stringify({ name: "Kathmandu Medical Suppliers" }), x.admin])).rows[0].id;
  await asOwner(c);
  return { ...x, item, u, vendor, vendor2 };
}
const bill = (c, x, o = {}) => c.query(
  `select post_purchase_invoice($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, null, $12, $13, null) id`,
  [x.t, o.key ?? uuid(), o.vendor ?? x.vendor, o.no ?? `HPD-${uuid().slice(0, 6)}`, o.date ?? d(-1), o.store ?? x.store,
   JSON.stringify(o.lines ?? [{ item_id: x.item, unit_id: x.u.strip, qty: 10, free_qty: 1, unit_cost: 100, discount_pct: 10, tax_rate: 13, batch_no: "hp101", expiry_date: d(400), mrp: 150 }]),
   o.billDiscount ?? 50, o.cash ?? 500, o.online ?? 0, o.channel ?? null, o.by ?? x.admin, o.level ?? "A2"]);

test("purchase bill: totals from the lines, free goods and bill discount in lot cost, stock and journal exact", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    const id = (await bill(c, x, { no: "HPD-1001" })).rows[0].id;
    await asOwner(c);
    const { rows: [h] } = await c.query(`select purchase_no, subtotal, line_discount_total, bill_discount, taxable_amount, tax_amount, total, paid_cash, credit_amount from purchase_invoices where id = $1`, [id]);
    assert.deepEqual(Object.values(h).slice(1).map(Number), [1000, 100, 50, 850, 110.5, 960.5, 500, 460.5], "gross 1000 − 10% = 900, − 50 bill discount = 850 + VAT 110.50");
    assert.match(h.purchase_no, /^PUR-\d{5}$/);
    const { rows: [lot] } = await c.query(`select ib.batch_no, ib.unit_cost_base::numeric cost, ib.mrp_base::numeric mrp, ib.source, b.qty_on_hand::numeric q from item_batches ib join stock_balances b on b.batch_id = ib.id where ib.item_id = $1`, [x.item]);
    assert.deepEqual([lot.batch_no, Number(lot.cost), Number(lot.mrp), lot.source, Number(lot.q)], ["HP101", 7.7273, 15, "purchase", 110], "850 ÷ (100 + 10 free) tablets");
    assert.deepEqual(await acct(c, x.t), { AP_VENDORS: -460.5, CASH: -500, INVENTORY: 850, TAX_RECEIVABLE: 110.5 });
    const { rows: [{ payable }] } = await c.query(`select payable from vendor_balances($1) where vendor_id = $2`, [x.t, x.vendor]);
    assert.equal(Number(payable), 460.5, "the payable is the journal balance, never a stored number");
  });
});

test("purchase rules: duplicate bill, expiry, shelf life, MRP, payment, password; a new lot every time", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    await bill(c, x, { no: "INV-77" });
    await expectError(c, `select post_purchase_invoice($1, $2, $3, ' inv-77 ', $4, $5, $6, 0, 0, 0, 0, null, null, $7, 'A2', null)`,
      [x.t, uuid(), x.vendor, d(-1), x.store, JSON.stringify([{ item_id: x.item, unit_id: x.u.tab, qty: 1, unit_cost: 1, batch_no: "Z", expiry_date: d(400) }]), x.admin], /DUPLICATE_BILL/);
    await bill(c, x, { no: "INV-77", vendor: x.vendor2 });  // same number from another vendor is fine
    const line = (o) => [{ item_id: x.item, unit_id: x.u.tab, qty: 10, unit_cost: 1, batch_no: "B1", expiry_date: d(400), ...o }];
    const bad = (lines, re, o = {}) => expectError(c, `select post_purchase_invoice($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, 0, null, null, $9, $10, null)`,
      [x.t, uuid(), x.vendor, `X-${uuid().slice(0, 5)}`, o.date ?? d(-1), x.store, JSON.stringify(lines), o.cash ?? 0, x.admin, o.level ?? "A2"], re);
    await bad(line({ expiry_date: null }), /EXPIRY_REQUIRED/);
    await bad(line({ expiry_date: d(-2) }), /EXPIRED_ON_ARRIVAL/);
    await bad(line({ expiry_date: d(30) }), /SHORT_SHELF_LIFE/);
    await bill(c, x, { lines: line({ expiry_date: d(30), short_expiry_reason: "Fast mover, vendor discount" }), billDiscount: 0, cash: 0 });
    await bad(line({ mrp: 2, sale_price: 3 }), /PRICE_ABOVE_MRP/);
    await bad(line({}), /OVERPAYMENT/, { cash: 11 });
    await bad(line({}), /PASSWORD_REQUIRED/, { level: "A1" });
    await bad(line({}), /BAD_BILL_DATE/, { date: d(3) });
    await asOwner(c);
    const { rows } = await c.query(`select count(*)::int n from item_batches where item_id = $1 and batch_no = 'B1'`, [x.item]);
    assert.equal(rows[0].n, 1);
    await asApp(c);
    await bill(c, x, { lines: line({ unit_cost: 2 }), billDiscount: 0, cash: 0 });
    await asOwner(c);
    const costs = (await c.query(`select unit_cost_base::numeric c from item_batches where item_id = $1 and batch_no = 'B1' order by c`, [x.item])).rows.map((r) => Number(r.c));
    assert.deepEqual(costs, [1, 2], "the same printed batch bought twice keeps two lots with their own costs");
  });
});

test("vendor payments: opening balance and bills settled oldest first, remainder becomes an advance; payable = journal", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    await c.query(`select post_vendor_opening($1, $2, $3, 1000, $4, $5, 'A2', null)`, [x.t, uuid(), x.vendor, d(-60), x.admin]);
    await expectError(c, `select post_vendor_opening($1, $2, $3, 5, null, $4, 'A2', null)`, [x.t, uuid(), x.vendor, x.admin], /OPENING_EXISTS/);
    const b1 = (await bill(c, x, { no: "OLD", date: d(-20) })).rows[0].id;        // 460.50 on credit
    const b2 = (await bill(c, x, { no: "NEW", date: d(-5), cash: 660.5 })).rows[0].id; // 300 on credit
    const pay = (cash, alloc = null) => c.query(`select post_vendor_payment($1, $2, $3, $4, 0, null, null, null, $5, $6, 'A2', null) id`, [x.t, uuid(), x.vendor, cash, alloc, x.admin]);
    await pay(1200);
    await asOwner(c);
    const out = async (id) => Number((await c.query(`select purchase_outstanding($1) o`, [id])).rows[0].o);
    assert.equal(await out(b1), 260.5, "opening 1000 paid in full, then 200 of the oldest bill");
    assert.equal(await out(b2), 300);
    await asApp(c);
    await expectError(c, `select post_vendor_payment($1, $2, $3, 400, 0, null, null, null, $4, $5, 'A2', null)`, [x.t, uuid(), x.vendor, JSON.stringify([{ purchase_invoice_id: b2, amount: 301 }]), x.admin], /ALLOCATION_TOO_LARGE/);
    await pay(300, JSON.stringify([{ purchase_invoice_id: b2, amount: 300 }]));
    await pay(400);                                                           // 260.50 to the old bill, 139.50 advance
    await expectError(c, `select post_vendor_payment($1, $2, $3, 10, 0, null, null, null, null, $4, 'A1', null)`, [x.t, uuid(), x.vendor, x.admin], /PASSWORD_REQUIRED/);
    await asOwner(c);
    const { rows: [bal] } = await c.query(`select payable::numeric p, advance::numeric a from vendor_balances($1) where vendor_id = $2`, [x.t, x.vendor]);
    assert.deepEqual([Number(bal.p), Number(bal.a)], [0, 139.5]);
    const outstanding = (await c.query(`select coalesce(sum(purchase_outstanding(id)), 0)::numeric s from purchase_invoices where vendor_id = $1`, [x.vendor])).rows[0].s;
    assert.equal(Number(outstanding), Number(bal.p), "payable from documents = payable from the journal");
  });
});

test("void: only with a fresh password, never once lots moved or the bill was paid; reverses stock and journal", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    const id = (await bill(c, x, { no: "OOPS-1" })).rows[0].id;
    await expectError(c, `select void_purchase_invoice($1, $2, $3, 'Entered twice', $4, 'A2', now() - interval '10 minutes', null)`, [x.t, uuid(), id, x.admin], /REAUTH_REQUIRED/);
    await c.query(`select void_purchase_invoice($1, $2, $3, 'Entered twice', $4, 'A2', now(), null)`, [x.t, uuid(), id, x.admin]);
    await asOwner(c);
    assert.deepEqual(Object.values(await acct(c, x.t)).every((v) => v === 0), true, "journal back to zero");
    assert.equal(Number((await c.query(`select coalesce(sum(qty_on_hand), 0) q from stock_balances where item_id = $1`, [x.item])).rows[0].q), 0);
    await asApp(c);
    await bill(c, x, { no: "OOPS-1" });                                       // re-entering a voided bill number is allowed
    const used = (await bill(c, x, { no: "USED-1" })).rows[0].id;
    const { rows: [lot] } = await c.query(`select batch_id from purchase_invoice_lines where purchase_id = $1`, [used]);
    await c.query(`select post_stock_adjustment($1, $2, $3, 'damaged', null, $4, $5, 'A2', null)`, [x.t, uuid(), x.store, JSON.stringify([{ batch_id: lot.batch_id, qty_base: -1 }]), x.admin]);
    await expectError(c, `select void_purchase_invoice($1, $2, $3, 'x', $4, 'A2', now(), null)`, [x.t, uuid(), used, x.admin], /LOTS_ALREADY_USED/);
    const paid = (await bill(c, x, { no: "PAID-1" })).rows[0].id;
    await c.query(`select post_vendor_payment($1, $2, $3, 10, 0, null, null, null, $4, $5, 'A2', null)`, [x.t, uuid(), x.vendor, JSON.stringify([{ purchase_invoice_id: paid, amount: 10 }]), x.admin]);
    await expectError(c, `select void_purchase_invoice($1, $2, $3, 'x', $4, 'A2', now(), null)`, [x.t, uuid(), paid, x.admin], /HAS_PAYMENTS/);
    await asOwner(c);
  });
});

test("ISOLATION: no bill or payment can use another clinic's vendor, item, store or bill", async () => {
  await withTx(async (c) => {
    const a = await setup(c), b = await setup(c);
    await asApp(c);
    await expectError(c, `select post_purchase_invoice($1, $2, $3, 'X1', $4, $5, $6, 0, 0, 0, 0, null, null, $7, 'A2', null)`,
      [a.t, uuid(), b.vendor, d(-1), a.store, JSON.stringify([{ item_id: a.item, unit_id: a.u.tab, qty: 1, unit_cost: 1, batch_no: "Q", expiry_date: d(400) }]), a.admin], /VENDOR_NOT_FOUND/);
    await expectError(c, `select post_purchase_invoice($1, $2, $3, 'X2', $4, $5, $6, 0, 0, 0, 0, null, null, $7, 'A2', null)`,
      [a.t, uuid(), a.vendor, d(-1), a.store, JSON.stringify([{ item_id: b.item, unit_id: b.u.tab, qty: 1, unit_cost: 1, batch_no: "Q", expiry_date: d(400) }]), a.admin], /ITEM_NOT_FOUND/);
    await expectError(c, `select post_purchase_invoice($1, $2, $3, 'X3', $4, $5, $6, 0, 0, 0, 0, null, null, $7, 'A2', null)`,
      [a.t, uuid(), a.vendor, d(-1), b.store, JSON.stringify([{ item_id: a.item, unit_id: a.u.tab, qty: 1, unit_cost: 1, batch_no: "Q", expiry_date: d(400) }]), a.admin], /NO_STORE_ACCESS|STORE_NOT_RECEIVING/);
    const bb = (await bill(c, b, { no: "B-ONLY" })).rows[0].id;
    await expectError(c, `select post_vendor_payment($1, $2, $3, 10, 0, null, null, null, $4, $5, 'A2', null)`, [a.t, uuid(), a.vendor, JSON.stringify([{ purchase_invoice_id: bb, amount: 10 }]), a.admin], /PURCHASE_NOT_FOUND/);
    await expectError(c, `select void_purchase_invoice($1, $2, $3, 'x', $4, 'A2', now(), null)`, [a.t, uuid(), bb, a.admin], /PURCHASE_NOT_FOUND/);
    await expectError(c, `select save_vendor($1, $2, '{"name":"Hijack"}', $3)`, [a.t, b.vendor, a.admin], /VENDOR_NOT_FOUND/);
    await asOwner(c);
  });
});
