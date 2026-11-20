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
