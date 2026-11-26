// B6b: purchase orders (received from bills), purchase returns (credit note / refund, VAT reversed),
// payable reconciliation, isolation. RPCs run as service_role.
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


// ── B6b: purchase orders, purchase returns, payable reconciliation ──
const po = (c, x, lines, o = {}) => c.query(`select create_purchase_order($1, $2, $3, $4, null, null, $5) id`, [x.t, o.by ?? x.admin, o.vendor ?? x.vendor, o.store ?? x.store, JSON.stringify(lines)]);
const recv = (c, id) => c.query(`select po_line_received($1) r`, [id]).then((r) => Number(r.rows[0].r));
const poStatus = (c, id) => c.query(`select status from purchase_orders where id = $1`, [id]).then((r) => r.rows[0].status);

test("purchase orders: received quantities come from the bills; status follows; void rolls back; cancel vs close", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    const P = (await po(c, x, [{ item_id: x.item, unit_id: x.u.strip, qty: 20, expected_unit_cost: 100 }])).rows[0].id;
    const { rows: [pl] } = await c.query(`select id, base_qty from purchase_order_lines where po_id = $1`, [P]);
    const line = (o) => [{ item_id: x.item, unit_id: x.u.strip, qty: 10, unit_cost: 100, batch_no: `PO${uuid().slice(0, 4)}`, expiry_date: d(400), po_line_id: pl.id, ...o }];
    await bill(c, x, { no: "PO-A", lines: line({}), billDiscount: 0, cash: 0 });
    assert.equal(await recv(c, pl.id), 100);
    assert.equal(await poStatus(c, P), "partially_received");
    await expectError(c, `select end_purchase_order($1, $2, $3, 'cancel', null)`, [x.t, x.admin, P], /PO_HAS_RECEIPTS/);
    const b2 = (await bill(c, x, { no: "PO-B", lines: line({}), billDiscount: 0, cash: 0 })).rows[0].id;
    assert.equal(await poStatus(c, P), "received");
    await c.query(`select void_purchase_invoice($1, $2, $3, 'Wrong bill', $4, 'A2', now(), null)`, [x.t, uuid(), b2, x.admin]);
    assert.equal(await poStatus(c, P), "partially_received", "voiding a bill un-receives it");
    await expectError(c, `select post_purchase_invoice($1, $2, $3, 'PO-C', $4, $5, $6, 0, 0, 0, 0, null, null, $7, 'A2', null)`,
      [x.t, uuid(), x.vendor2, d(-1), x.store, JSON.stringify(line({})), x.admin], /PO_LINE_NOT_FOUND/);   // another vendor's bill
    await c.query(`select end_purchase_order($1, $2, $3, 'close', 'Vendor out of stock')`, [x.t, x.admin, P]);
    await expectError(c, `select post_purchase_invoice($1, $2, $3, 'PO-D', $4, $5, $6, 0, 0, 0, 0, null, null, $7, 'A2', null)`,
      [x.t, uuid(), x.vendor, d(-1), x.store, JSON.stringify(line({})), x.admin], /PO_LINE_NOT_FOUND/);    // closed order
    const P2 = (await po(c, x, [{ item_id: x.item, unit_id: x.u.box, qty: 1 }])).rows[0].id;
    await c.query(`select end_purchase_order($1, $2, $3, 'cancel', null)`, [x.t, x.admin, P2]);
    assert.equal(await poStatus(c, P2), "cancelled");
    assert.match((await c.query(`select po_no from purchase_orders where id = $1`, [P])).rows[0].po_no, /^PO-\d{5}$/);
    await asOwner(c);
  });
});

test("purchase returns: credit note settles the bill (oldest first, rest = advance), refund brings money in; VAT reversed; limits", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    const b1 = (await bill(c, x, { no: "R-1" })).rows[0].id;                         // 960.50, 460.50 on credit; lot cost 7.7273/tab, VAT 13%
    const { rows: [l1] } = await c.query(`select batch_id from purchase_invoice_lines where purchase_id = $1`, [b1]);
    const ret = (settle, lines, o = {}) => c.query(`select post_purchase_return($1, $2, $3, $4, $5, $6, $7, null, $8, $9, 'A2', null) id`,
      [x.t, uuid(), o.vendor ?? x.vendor, x.store, o.invoice === undefined ? b1 : o.invoice, settle, o.channel ?? null, JSON.stringify(lines), x.admin]);
    const r1 = (await ret("credit_note", [{ batch_id: l1.batch_id, qty_base: 20, reason: "damaged" }])).rows[0].id;
    await asOwner(c);
    const { rows: [h] } = await c.query(`select net_amount::numeric n, tax_amount::numeric t, total::numeric s, return_no from purchase_returns where id = $1`, [r1]);
    assert.deepEqual([Number(h.n), Number(h.t), Number(h.s)], [154.55, 20.09, 174.64], "20 tabs × 7.7273 + 13% VAT");
    assert.match(h.return_no, /^PR-\d{5}$/);
    assert.equal(Number((await c.query(`select purchase_outstanding($1) o`, [b1])).rows[0].o), 285.86, "460.50 − 174.64");
    assert.equal(Number((await c.query(`select qty_on_hand q from stock_balances where batch_id = $1`, [l1.batch_id])).rows[0].q), 90);
    await asApp(c);
    await expectError(c, `select post_purchase_return($1, $2, $3, $4, $5, 'credit_note', null, null, $6, $7, 'A2', null)`,
      [x.t, uuid(), x.vendor, x.store, b1, JSON.stringify([{ batch_id: l1.batch_id, qty_base: 91, reason: "excess" }]), x.admin], /MORE_THAN_RECEIVED|INSUFFICIENT_STOCK/);
    await expectError(c, `select post_purchase_return($1, $2, $3, $4, null, 'credit_note', null, null, $5, $6, 'A2', null)`,
      [x.t, uuid(), x.vendor2, x.store, JSON.stringify([{ batch_id: l1.batch_id, qty_base: 1, reason: "excess" }]), x.admin], /LOT_FROM_ANOTHER_VENDOR/);
    await expectError(c, `select post_purchase_return($1, $2, $3, $4, null, 'credit_note', null, null, $5, $6, 'A2', null)`,
      [x.t, uuid(), x.vendor, x.store, JSON.stringify([{ batch_id: l1.batch_id, qty_base: 1 }]), x.admin], /REASON_REQUIRED/);
    // recalled lots can go back too; a big credit note clears the bill and leaves an advance
    await asOwner(c);
    await c.query(`update item_batches set status = 'recalled', blocked_at = now(), block_reason = 'recall' where id = $1`, [l1.batch_id]);
    await asApp(c);
    await ret("credit_note", [{ batch_id: l1.batch_id, qty_base: 80, reason: "recall" }]);
    await ret("cash_refund", [{ batch_id: l1.batch_id, qty_base: 5, reason: "recall" }], { invoice: null });
    await expectError(c, `select post_purchase_return($1, $2, $3, $4, null, 'online_refund', null, null, $5, $6, 'A2', null)`,
      [x.t, uuid(), x.vendor, x.store, JSON.stringify([{ batch_id: l1.batch_id, qty_base: 1, reason: "recall" }]), x.admin], /CHANNEL_REQUIRED/);
    await asOwner(c);
    assert.equal(Number((await c.query(`select purchase_outstanding($1) o`, [b1])).rows[0].o), 0, "bill fully settled by credit notes");
    const { rows: [bal] } = await c.query(`select payable::numeric p, advance::numeric a from vendor_balances($1) where vendor_id = $2`, [x.t, x.vendor]);
    assert.equal(Number(bal.p), 0);
    assert.ok(Number(bal.a) > 0, "the unused credit note is an advance from the vendor");
    const j = Object.fromEntries((await c.query(`select account_code a, sum(debit - credit)::numeric n from ledger_entries where tenant_id = $1 group by 1`, [x.t])).rows.map((r) => [r.a, Number(r.n)]));
    const { rows: [{ led }] } = await c.query(`select coalesce(sum(qty_base * unit_cost_base), 0)::numeric led from stock_movements where tenant_id = $1`, [x.t]);
    assert.ok(Math.abs(j.INVENTORY - Number(led)) < 0.05, `inventory in the accounts ${j.INVENTORY} = stock ledger ${led}`);
    assert.ok(j.CASH < 0 && j.CASH > -500, "the cash refund came back in");
    assert.equal((await c.query(`select reconcile_vendor_payables($1) r`, [x.t])).rows[0].r.mismatches, 0, "payables reconcile");
  });
});

test("payable check: documents and journal agree; a tampered allocation is caught and logged", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    await bill(c, x, { no: "PC-1" });
    await c.query(`select post_vendor_payment($1, $2, $3, 100, 0, null, null, null, null, $4, 'A2', null)`, [x.t, uuid(), x.vendor, x.admin]);
    assert.deepEqual((await c.query(`select reconcile_vendor_payables($1) r`, [x.t])).rows[0].r, { vendors: 2, mismatches: 0 });
    await asOwner(c);
    await c.query(`delete from vendor_payment_allocations where tenant_id = $1`, [x.t]);   // tampering (owner role only)
    await asApp(c);
    assert.equal((await c.query(`select reconcile_vendor_payables($1) r`, [x.t])).rows[0].r.mismatches, 1);
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from audit_log where tenant_id = $1 and action = 'payable.reconcile' and outcome = 'error'`, [x.t])).rows[0].n, 1);
  });
});

test("ISOLATION: orders and returns can't use another clinic's vendor, store, item or lots", async () => {
  await withTx(async (c) => {
    const a = await setup(c), b = await setup(c);
    await asApp(c);
    await expectError(c, `select create_purchase_order($1, $2, $3, $4, null, null, $5)`, [a.t, a.admin, b.vendor, a.store, JSON.stringify([{ item_id: a.item, unit_id: a.u.tab, qty: 1 }])], /VENDOR_NOT_FOUND/);
    await expectError(c, `select create_purchase_order($1, $2, $3, $4, null, null, $5)`, [a.t, a.admin, a.vendor, a.store, JSON.stringify([{ item_id: b.item, unit_id: b.u.tab, qty: 1 }])], /ITEM_NOT_FOUND/);
    const bb = (await bill(c, b, { no: "ISO-B" })).rows[0].id;
    const { rows: [lb] } = await c.query(`select batch_id from purchase_invoice_lines where purchase_id = $1`, [bb]);
    await expectError(c, `select post_purchase_return($1, $2, $3, $4, null, 'credit_note', null, null, $5, $6, 'A2', null)`,
      [a.t, uuid(), a.vendor, a.store, JSON.stringify([{ batch_id: lb.batch_id, qty_base: 1, reason: "excess" }]), a.admin], /LOT_NOT_FOUND/);
    await expectError(c, `select post_purchase_return($1, $2, $3, $4, $5, 'credit_note', null, null, $6, $7, 'A2', null)`,
      [a.t, uuid(), a.vendor, a.store, bb, JSON.stringify([{ batch_id: lb.batch_id, qty_base: 1, reason: "excess" }]), a.admin], /PURCHASE_NOT_FOUND/);
    await asOwner(c);
  });
});

// ── Pharmacy track step 2 (D-143): vendor credit used on later bills, found stock as a proper lot ──
test("vendor credit: an overpayment and an unused credit note pay later bills, oldest first; payables still reconcile", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    const b1 = (await bill(c, x, { no: "VC-1" })).rows[0].id;                         // 460.50 on credit
    await c.query(`select post_vendor_payment($1, $2, $3, 600, 0, null, null, null, null, $4, 'A2', null)`, [x.t, uuid(), x.vendor, x.admin]);
    const owed = async (b) => Number((await c.query(`select purchase_outstanding($1) o`, [b])).rows[0].o);
    assert.equal(await owed(b1), 0);
    const adv = async () => Number((await c.query(`select advance::numeric a from vendor_balances($1) where vendor_id = $2`, [x.t, x.vendor])).rows[0].a);
    assert.equal(await adv(), 139.5, "600 − 460.50 held as an advance");
    await expectError(c, `select apply_vendor_credit($1, $2, $3, $4, 'A2', null)`, [x.t, uuid(), x.vendor, x.admin], /NOTHING_TO_APPLY/);
    // a credit note with no bill to settle adds to the credit
    const { rows: [l1] } = await c.query(`select batch_id from purchase_invoice_lines where purchase_id = $1`, [b1]);
    await c.query(`select post_purchase_return($1, $2, $3, $4, null, 'credit_note', null, null, $5, $6, 'A2', null)`,
      [x.t, uuid(), x.vendor, x.store, JSON.stringify([{ batch_id: l1.batch_id, qty_base: 20, reason: "damaged" }]), x.admin]);
    assert.equal(await adv(), 314.14, "plus the 174.64 credit note");
    const b2 = (await bill(c, x, { no: "VC-2", cash: 700 })).rows[0].id;              // 260.50 on credit
    const b3 = (await bill(c, x, { no: "VC-3", cash: 700 })).rows[0].id;              // 260.50 on credit
    await expectError(c, `select apply_vendor_credit($1, $2, $3, $4, 'A2', null)`, [x.t, uuid(), x.vendor, x.pharmacist], /NO_PERMISSION/);
    await expectError(c, `select apply_vendor_credit($1, $2, $3, $4, 'A1', null)`, [x.t, uuid(), x.vendor, x.admin], /PASSWORD_REQUIRED/);
    const key = uuid();
    const r = (await c.query(`select apply_vendor_credit($1, $2, $3, $4, 'A2', null) r`, [x.t, key, x.vendor, x.admin])).rows[0].r;
    assert.deepEqual([Number(r.applied), r.bills], [314.14, 2]);
    assert.equal((await c.query(`select apply_vendor_credit($1, $2, $3, $4, 'A2', null) r`, [x.t, key, x.vendor, x.admin])).rows[0].r.replayed, true);
    assert.deepEqual([await owed(b2), await owed(b3)], [0, 206.86], "the older bill is cleared first");
    assert.equal(await adv(), 0);
    const { rows: [bal] } = await c.query(`select payable::numeric p from vendor_balances($1) where vendor_id = $2`, [x.t, x.vendor]);
    assert.equal(Number(bal.p), 206.86);
    assert.equal((await c.query(`select reconcile_vendor_payables($1) r`, [x.t])).rows[0].r.mismatches, 0, "documents and journal agree");
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from audit_log where tenant_id = $1 and action = 'vendor.credit_applied'`, [x.t])).rows[0].n, 1);
  });
});

test("found stock: a proper lot (capital batch, expiry needed for medicines, MRP and sale price)", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    const found = (line) => c.query(`select post_stock_adjustment($1, $2, $3, 'found', 'Behind the shelf', $4, $5, 'A2', null) id`,
      [x.t, uuid(), x.store, JSON.stringify([{ item_id: x.item, unit_id: x.u.strip, qty: 2, unit_cost: 80, ...line }]), x.admin]);
    await expectError(c, `select post_stock_adjustment($1, $2, $3, 'found', null, $4, $5, 'A2', null)`,
      [x.t, uuid(), x.store, JSON.stringify([{ item_id: x.item, unit_id: x.u.strip, qty: 1, unit_cost: 80, batch_no: "x1" }]), x.admin], /EXPIRY_REQUIRED/);
    await expectError(c, `select post_stock_adjustment($1, $2, $3, 'found', null, $4, $5, 'A2', null)`,
      [x.t, uuid(), x.store, JSON.stringify([{ item_id: x.item, unit_id: x.u.strip, qty: 1, unit_cost: 80, expiry_date: d(300) }]), x.admin], /BATCH_REQUIRED/);
    await expectError(c, `select post_stock_adjustment($1, $2, $3, 'found', null, $4, $5, 'A2', null)`,
      [x.t, uuid(), x.store, JSON.stringify([{ item_id: x.item, unit_id: x.u.strip, qty: 1, unit_cost: 80, batch_no: "f1", expiry_date: d(300), mrp: 100, sale_price: 120 }]), x.admin], /PRICE_ABOVE_MRP/);
    await found({ batch_no: " fd 22 ", expiry_date: d(300), mrp: 150 });
    await asOwner(c);
    const { rows: [lot] } = await c.query(`select batch_no, source, unit_cost_base::numeric c, mrp_base::numeric m, sale_price_base::numeric s from item_batches where tenant_id = $1 and source = 'found'`, [x.t]);
    assert.deepEqual([lot.batch_no, Number(lot.c), Number(lot.m), Number(lot.s)], ["FD22", 8, 15, 15], "per tablet: cost 8, MRP and price 15 (not the cost)");
  });
});

// ── M-46 (D-144): purchase plan from real use, vendor performance, the PO approval limit ──
const sellTabs = async (c, x, item, unit, qty) => {
  const { rows: [p] } = await c.query(`select sale_price_base::numeric p from item_batches where item_id = $1 order by created_at limit 1`, [item]);
  return c.query(`select issue_counter_sale($1, $2, $3, null, 'Walk-in', null, $4, null, $5, 0, null, null, $6, 'A1', null) r`,
    [x.t, uuid(), x.store, JSON.stringify([{ kind: "item", item_id: item, unit_id: unit, qty }]), Math.round(qty * Number(p.p) * 100) / 100, x.admin]);
};

test("purchase plan: what to order from how fast it sells and the vendor's delivery time; orders already placed count", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    const { rows: [{ id: velo }] } = await save(c, x, PARA({ name: "Velocid 500", reorder_level: null, min_stock_level: null, barcodes: [] }));
    const uv = await units(c, velo);
    await bill(c, x, { no: "PL-1", lines: [{ item_id: velo, unit_id: uv.strip, qty: 10, free_qty: 1, unit_cost: 100, tax_rate: 0, batch_no: "VL1", expiry_date: d(400), mrp: 150 }], billDiscount: 0, cash: 0 });
    const row = async () => (await c.query(`select * from purchase_plan($1, $2, 30) where item_id = $3`, [x.t, x.store, velo])).rows[0];
    assert.equal(await row(), undefined, "110 on hand and nothing sold: nothing to order");
    await sellTabs(c, x, velo, uv.tab, 90);
    let r = await row();
    assert.deepEqual([r.reason, Number(r.on_hand), Number(r.per_day), Number(r.days_left), Number(r.lead_days), r.vendor_id],
      ["sales", 20, 3, 6.7, 7, x.vendor], "3 a day, 20 left: under a week's delivery plus a week");
    assert.deepEqual([Number(r.suggested_base), r.purchase_unit, Number(r.suggested_units)], [91, "box", 1], "3 × (7 + 30) − 20 = 91 tabs → 1 box");
    await c.query(`select save_vendor($1, $2, $3, $4)`, [x.t, x.vendor, JSON.stringify({ name: "Himalayan Pharma Distributors", lead_time_days: 14 }), x.admin]);
    r = await row();
    assert.deepEqual([Number(r.lead_days), Number(r.suggested_base)], [14, 112], "a slower vendor: 3 × (14 + 30) − 20");
    await po(c, x, [{ item_id: velo, unit_id: uv.box, qty: 1, expected_unit_cost: 900 }]);
    assert.equal(await row(), undefined, "a box already on order covers it");
  });
});

test("vendor performance: fill rate, on time, delivery days, returns, price changes, shelf life at receipt", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    const P = (await c.query(`select create_purchase_order($1, $2, $3, $4, $5, null, $6) id`, [x.t, x.admin, x.vendor, x.store, d(5),
      JSON.stringify([{ item_id: x.item, unit_id: x.u.strip, qty: 20, expected_unit_cost: 100 }])])).rows[0].id;
    const { rows: [pl] } = await c.query(`select id from purchase_order_lines where po_id = $1`, [P]);
    await bill(c, x, { no: "VP-1", lines: [{ item_id: x.item, unit_id: x.u.strip, qty: 10, unit_cost: 100, tax_rate: 0, batch_no: "VP1", expiry_date: d(400), mrp: 150, po_line_id: pl.id }], billDiscount: 0, cash: 1000 });
    const b2 = (await bill(c, x, { no: "VP-2", lines: [{ item_id: x.item, unit_id: x.u.strip, qty: 10, unit_cost: 120, tax_rate: 0, batch_no: "VP2", expiry_date: d(100), mrp: 150 }], billDiscount: 0, cash: 1200 })).rows[0].id;
    const { rows: [l2] } = await c.query(`select batch_id from purchase_invoice_lines where purchase_id = $1`, [b2]);
    await c.query(`select post_purchase_return($1, $2, $3, $4, $5, 'cash_refund', null, null, $6, $7, 'A2', null)`,
      [x.t, uuid(), x.vendor, x.store, b2, JSON.stringify([{ batch_id: l2.batch_id, qty_base: 20, reason: "near_expiry" }]), x.admin]);
    const p = (await c.query(`select vendor_performance($1, $2, 365) p`, [x.t, x.vendor])).rows[0].p;
    assert.equal(Number(p.fill_rate), 50, "10 of 20 strips ordered came");
    assert.equal(Number(p.on_time_rate), 100);
    assert.equal(Number(p.delivery_days), 0);
    assert.equal(Number(p.return_rate), 10.9, "240 back of 2,200 bought");
    assert.equal(p.short_dated_lots, 1, "the lot with 100 days left");
    assert.equal(p.price_changes[0].change_pct, 20, "100 → 120 per strip");
  });
});

test("approval limit: a big order waits for the owner; it can't be received until approved; rejected needs a reason", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    const { rows: [r] } = await c.query(`insert into tenant_roles (tenant_id, name, permissions) values ($1, 'Buyer', $2) returning id`, [x.t, ["manage_purchases"]]);
    await c.query(`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [x.t, x.pharmacist, r.id]);
    await c.query(`update tenant_settings set po_approval_limit = 1000 where tenant_id = $1`, [x.t]);
    await asApp(c);
    const order = (by, qty, cost = 100) => c.query(`select create_purchase_order($1, $2, $3, $4, null, null, $5) id`, [x.t, by, x.vendor, x.store,
      JSON.stringify([{ item_id: x.item, unit_id: x.u.strip, qty, expected_unit_cost: cost }])]).then((q) => q.rows[0].id);
    const status = async (id) => (await c.query(`select status from purchase_orders where id = $1`, [id])).rows[0].status;
    const small = await order(x.pharmacist, 5), big = await order(x.pharmacist, 20), noCost = await order(x.pharmacist, 1, null), own = await order(x.admin, 50);
    assert.deepEqual([await status(small), await status(big), await status(noCost), await status(own)], ["open", "pending_approval", "pending_approval", "open"]);
    const { rows: [pl] } = await c.query(`select id from purchase_order_lines where po_id = $1`, [big]);
    await expectError(c, `select post_purchase_invoice($1, $2, $3, 'PA-1', $4, $5, $6, 0, 0, 0, 0, null, null, $7, 'A2', null)`,
      [x.t, uuid(), x.vendor, d(-1), x.store, JSON.stringify([{ item_id: x.item, unit_id: x.u.strip, qty: 5, unit_cost: 100, batch_no: "PA1", expiry_date: d(300), po_line_id: pl.id }]), x.admin], /PO_LINE_NOT_FOUND/);
    await expectError(c, `select decide_purchase_order($1, $2, $3, true, null)`, [x.t, x.pharmacist, big], /NO_PERMISSION/);
    await expectError(c, `select decide_purchase_order($1, $2, $3, false, '')`, [x.t, x.admin, noCost], /REASON_REQUIRED/);
    await c.query(`select decide_purchase_order($1, $2, $3, true, null)`, [x.t, x.admin, big]);
    await c.query(`select decide_purchase_order($1, $2, $3, false, 'Buy from the cheaper vendor')`, [x.t, x.admin, noCost]);
    assert.deepEqual([await status(big), await status(noCost)], ["open", "cancelled"]);
    await expectError(c, `select decide_purchase_order($1, $2, $3, true, null)`, [x.t, x.admin, big], /PO_NOT_PENDING/);
    await asOwner(c);
    const { rows: [n] } = await c.query(`select count(*)::int n from notifications where tenant_id = $1 and kind = 'po_approval' and member_id = $2`, [x.t, x.admin]);
    assert.equal(n.n, 2, "the owner was told about both waiting orders");
    const { rows: [po2] } = await c.query(`select approved_by, closed_reason from purchase_orders where id = $1`, [noCost]);
    assert.equal(po2.closed_reason, "Not approved: Buy from the cheaper vendor");
  });
});

// ── D-152: one batch, one lot ──
test("the same batch bought again at the same cost joins its lot; a different cost stays separate; void and returns per bill", async () => {
  await withTx(async (c) => {
    const x = await setup(c);
    await asApp(c);
    const line = (o = {}) => ({ item_id: x.item, unit_id: x.u.strip, qty: 10, free_qty: 0, unit_cost: 100, discount_pct: 0, tax_rate: 0, batch_no: "3333h", expiry_date: d(400), mrp: 150, ...o });
    const b1 = (await bill(c, x, { no: "OB-1", lines: [line()], billDiscount: 0, cash: 0 })).rows[0].id;
    const b2 = (await bill(c, x, { no: "OB-2", lines: [line({ qty: 5 })], billDiscount: 0, cash: 0 })).rows[0].id;
    const lots = async () => (await c.query(`select ib.id, ib.unit_cost_base::numeric cost, coalesce(sum(b.qty_on_hand), 0)::numeric q from item_batches ib
      left join stock_balances b on b.batch_id = ib.id where ib.tenant_id = $1 and ib.batch_no = '3333H' group by ib.id order by ib.unit_cost_base desc`, [x.t])).rows;
    let l = await lots();
    assert.deepEqual(l.map((y) => [Number(y.cost), Number(y.q)]), [[10, 150]], "one lot of 150 tabs (100 + 50) at Rs. 10 a tab");
    const { rows: lines } = await c.query(`select batch_id from purchase_invoice_lines where purchase_id in ($1, $2)`, [b1, b2]);
    assert.ok(lines.every((y) => y.batch_id === l[0].id), "both bills point at the same lot");
    // a different cost (a 10% discount this time) makes its own lot
    await bill(c, x, { no: "OB-3", lines: [line({ discount_pct: 10 })], billDiscount: 0, cash: 0 });
    l = await lots();
    assert.deepEqual(l.map((y) => [Number(y.cost), Number(y.q)]), [[10, 150], [9, 100]], "Rs. 9 a tab stays separate");
    // returning against bill 2 is limited to what bill 2 brought (50 tabs)
    await expectError(c, `select post_purchase_return($1, $2, $3, $4, $5, 'credit_note', null, null, $6, $7, 'A2', null)`,
      [x.t, uuid(), x.vendor, x.store, b2, JSON.stringify([{ batch_id: l[0].id, qty_base: 60, reason: "excess" }]), x.admin], /MORE_THAN_RECEIVED/);
    await c.query(`select post_purchase_return($1, $2, $3, $4, $5, 'credit_note', null, null, $6, $7, 'A2', null)`,
      [x.t, uuid(), x.vendor, x.store, b2, JSON.stringify([{ batch_id: l[0].id, qty_base: 20, reason: "excess" }]), x.admin]);
    // bill 1 can be voided while its 100 tabs are still on the shelf (130 left after the return)
    await c.query(`select void_purchase_invoice($1, $2, $3, 'Entered twice', $4, 'A2', now(), null)`, [x.t, uuid(), b1, x.admin]);
    assert.equal(Number((await lots())[0].q), 30, "150 − 20 returned − 100 voided");
    // books still agree
    const { rows: [{ r: rec }] } = await c.query(`select reconcile_stock_balances($1) r`, [x.t]);
    assert.equal(rec.mismatches, 0);
  });
});
