// B5c stock alerts, purchase suggestions and reconciliation. RPCs run as service_role.
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


// ── B5c: alerts, purchase suggestions, reconciliation ──
const d = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
async function shelf(c) {
  const x = await clinic(c);
  await asApp(c);
  const { rows: [{ id }] } = await save(c, x, PARA({ barcodes: [], min_stock_level: 50, reorder_level: 200, max_stock_level: 500 }));
  const u = await units(c, id);
  await open(c, x, [
    { item_id: id, unit_id: u.tab, qty: 30, batch_no: "GOOD", expiry_date: d(300), unit_cost: 2 },
    { item_id: id, unit_id: u.tab, qty: 10, batch_no: "EXPIRED", expiry_date: d(-2), unit_cost: 2 },
    { item_id: id, unit_id: u.tab, qty: 20, batch_no: "SOON", expiry_date: d(20), unit_cost: 2 },
    { item_id: id, unit_id: u.tab, qty: 5, batch_no: "BLOCKED", expiry_date: d(200), unit_cost: 2 },
  ], { by: x.admin });
  await asOwner(c);
  await c.query(`update item_batches set status = 'recalled', blocked_at = now(), block_reason = 'test' where item_id = $1 and batch_no = 'BLOCKED'`, [id]);
  return { ...x, item: id, u };
}
const alerts = async (c, x, store = null) => (await c.query(`select kind, severity, batch_no, qty_base::numeric q from stock_alerts($1, $2) order by kind, batch_no`, [x.t, store])).rows
  .map((r) => [r.kind, r.severity, r.batch_no, Number(r.q)]);

test("alerts: expired, recalled, near-expiry and stock-level problems, per store, never from quarantine", async () => {
  await withTx(async (c) => {
    const x = await shelf(c);
    await asApp(c);
    assert.deepEqual(await alerts(c, x), [
      ["blocked", "critical", "BLOCKED", 5],
      ["critical_stock", "critical", null, 50],
      ["expired", "critical", "EXPIRED", 10],
      ["near_expiry", "critical", "SOON", 20],
    ], "sellable = 30 good + 20 soon = 50, at the minimum");
    await asOwner(c);
    await c.query(`insert into store_item_levels (tenant_id, store_id, item_id, min_stock_level, reorder_level) values ($1, $2, $3, 5, 10)`, [x.t, x.store, x.item]);
    await c.query(`update tenant_settings set critical_expiry_days = 10 where tenant_id = $1`, [x.t]);
    await asApp(c);
    const k = await alerts(c, x, x.store);
    assert.ok(!k.some(([kind]) => kind.endsWith("_stock")), "the store's own (lower) levels override the item's");
    assert.deepEqual(k.find(([kind]) => kind === "near_expiry"), ["near_expiry", "warning", "SOON", 20], "20 days left is a warning when critical = 10 days");
    assert.equal((await alerts(c, x, x.quarantine)).length, 0, "quarantine stock doesn't raise alerts");
    await asOwner(c);
  });
});

test("purchase suggestions: up to the maximum, rounded up to whole purchase units, at the last cost", async () => {
  await withTx(async (c) => {
    const x = await shelf(c);
    await asApp(c);
    const { rows: [s] } = await c.query(`select suggested_base::numeric b, purchase_unit, suggested_units::numeric n, est_cost::numeric cost from purchase_suggestions($1, null) where item_id = $2`, [x.t, x.item]);
    assert.deepEqual([Number(s.b), s.purchase_unit, Number(s.n)], [450, "box", 5], "500 max - 50 sellable = 450 tabs = 4.5 boxes, so 5 boxes");
    assert.equal(Number(s.cost), 1000, "500 tabs at Rs. 2 (the latest lot's cost)");
    await asOwner(c);
  });
});

test("reconciliation: balance = sum of ledger; a tampered or missing balance is repaired and logged", async () => {
  await withTx(async (c) => {
    const x = await shelf(c);
    await asApp(c);
    assert.deepEqual((await c.query(`select reconcile_stock_balances($1, $2) r`, [x.t, x.admin])).rows[0].r, { checked: 4, mismatches: 0 });
    await asOwner(c);
    const { rows: [g] } = await c.query(`select id from item_batches where item_id = $1 and batch_no = 'GOOD'`, [x.item]);
    await c.query(`update stock_balances set qty_on_hand = 999 where batch_id = $1`, [g.id]);          // tampering (only the owner role could)
    await c.query(`delete from stock_balances where batch_id = (select id from item_batches where item_id = $1 and batch_no = 'SOON')`, [x.item]);
    await asApp(c);
    assert.deepEqual((await c.query(`select reconcile_stock_balances($1, null) r`, [x.t])).rows[0].r, { checked: 4, mismatches: 2 });
    await asOwner(c);
    assert.equal(Number((await c.query(`select qty_on_hand from stock_balances where batch_id = $1`, [g.id])).rows[0].qty_on_hand), 30, "rebuilt from the ledger");
    assert.equal((await c.query(`select count(*)::int n from stock_balances where tenant_id = $1`, [x.t])).rows[0].n, 4, "missing balance row recreated");
    assert.equal((await c.query(`select count(*)::int n from audit_log where tenant_id = $1 and action = 'stock.reconcile' and outcome = 'error'`, [x.t])).rows[0].n, 1);
    await asApp(c);
    assert.equal((await c.query(`select reconcile_stock_balances($1, null) r`, [x.t])).rows[0].r.mismatches, 0, "clean afterwards");
    await expectError(c, `insert into stock_reconciliations (tenant_id, checked, mismatches) values ($1, 0, 0)`, [x.t], /permission denied/);
    await asOwner(c);
  });
});

test("ISOLATION: alerts and suggestions never show another clinic's stock", async () => {
  await withTx(async (c) => {
    const a = await shelf(c), b = await shelf(c);
    await asApp(c);
    assert.equal((await c.query(`select count(*)::int n from stock_alerts($1, $2)`, [a.t, b.store])).rows[0].n, 0);
    assert.equal((await c.query(`select count(*)::int n from purchase_suggestions($1, $2)`, [a.t, b.store])).rows[0].n, 0);
    await asOwner(c);
  });
});
