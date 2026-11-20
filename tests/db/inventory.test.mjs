// B5a inventory core: item master (units, barcodes, generics), opening stock posted to the
// ledger and journal, never-negative balances, immutable movements, FEFO allocation, store
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

test("item master: codes, generic reused, units with one base, barcodes unique, factor locked once stocked", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    const { rows: [{ id }] } = await save(c, x, PARA());
    const { rows: [{ id: id2 }] } = await save(c, x, PARA({ name: "Paracetamol 500 (generic)", manufacturer: "nepal pharmaceuticals", barcodes: [] }));
    await asOwner(c);
    const { rows: [i1] } = await c.query(`select item_code, (select count(*)::int from item_units where item_id = $1) u, default_sale_unit_id is not null s from inventory_items where id = $1`, [id]);
    assert.deepEqual([i1.item_code, i1.u, i1.s], ["ITM-00001", 3, true]);
    assert.equal((await c.query(`select item_code from inventory_items where id = $1`, [id2])).rows[0].item_code, "ITM-00002");
    assert.equal((await c.query(`select count(*)::int n from generics where tenant_id = $1`, [x.t])).rows[0].n, 1, "same generic reused");
    assert.equal((await c.query(`select count(*)::int n from manufacturers where tenant_id = $1`, [x.t])).rows[0].n, 1, "manufacturer matched case-insensitively");
    assert.equal((await c.query(`select requires_prescription from medicine_details where item_id = $1`, [id])).rows[0].requires_prescription, false, "OTC needs no prescription");
    await asApp(c);
    await expectError(c, `select save_item($1, null, $2, $3)`, [x.t, JSON.stringify(PARA({ name: "Two Bases", units: [{ name: "tab", factor: 1, is_base: true }, { name: "x", factor: 1, is_base: true }] })), x.admin], /ONE_BASE_UNIT/);
    await expectError(c, `select save_item($1, null, $2, $3)`, [x.t, JSON.stringify(PARA({ name: "Dup Barcode" })), x.admin], /BARCODE_TAKEN/);
    await expectError(c, `select save_item($1, null, $2, $3)`, [x.t, JSON.stringify(PARA({ name: "Bad Levels", min_stock_level: 300, reorder_level: 100, barcodes: [] })), x.admin], /check/);
    await expectError(c, `insert into inventory_items (tenant_id, item_code, item_type, name) values ($1, 'X', 'other', 'Direct')`, [x.t], /permission denied/);

    const u = await units(c, id);
    await open(c, x, [{ item_id: id, unit_id: u.strip, qty: 5, batch_no: "cm2401", expiry_date: "2027-03-31", unit_cost: 12, mrp: 20 }]);
    const changed = PARA({ units: [{ id: u.tab, name: "tab", factor: 1, is_base: true }, { id: u.strip, name: "strip", factor: 15 }, { id: u.box, name: "box", factor: 100 }] });
    await expectError(c, `select save_item($1, $2, $3, $4)`, [x.t, id, JSON.stringify(changed), x.admin], /UNIT_IN_USE/);
    const renamed = PARA({ name: "Cetamol 500 mg", units: [{ id: u.tab, name: "tablet", factor: 1, is_base: true }, { id: u.strip, name: "strip", factor: 10 }, { id: u.box, name: "box", factor: 100 }] });
    await save(c, x, renamed, id);
    await asOwner(c);
  });
});

test("opening stock: base units, lots, ledger, balances and journal; idempotent; rules", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    const { rows: [{ id }] } = await save(c, x, PARA());
    const { rows: [{ id: gauze }] } = await save(c, x, { item_type: "consumable", name: "Gauze roll", units: [{ name: "roll", factor: 1, is_base: true }] });
    const u = await units(c, id), g = await units(c, gauze);
    const key = uuid();
    const lines = [
      { item_id: id, unit_id: u.strip, qty: 5, batch_no: " cm2401 ", expiry_date: "2027-03-31", unit_cost: 12, mrp: 20 },
      { item_id: id, unit_id: u.box, qty: 1, batch_no: "CM2405", expiry_date: "2027-08-31", unit_cost: 110, mrp: 200 },
      { item_id: gauze, unit_id: g.roll, qty: 10, unit_cost: 35 },
    ];
    const { rows: [{ id: o1 }] } = await open(c, x, lines, { key });
    assert.equal((await open(c, x, lines, { key })).rows[0].id, o1, "a retry returns the first posting");
    await asOwner(c);
    const bal = (await c.query(`select ib.batch_no, b.qty_on_hand::numeric q, ib.unit_cost_base::numeric cost from stock_balances b join item_batches ib on ib.id = b.batch_id where b.tenant_id = $1 order by 1`, [x.t])).rows
      .map((r) => [r.batch_no, Number(r.q), Number(r.cost)]);
    assert.deepEqual(bal, [["CM2401", 50, 1.2], ["CM2405", 100, 1.1], ["NA", 10, 35]], "strips and boxes become tablets; batch numbers normalised");
    const j = Object.fromEntries((await c.query(`select account_code a, sum(debit - credit)::numeric n from ledger_entries where tenant_id = $1 group by 1`, [x.t])).rows.map((r) => [r.a, Number(r.n)]));
    assert.deepEqual(j, { INVENTORY: 520, OPENING_EQUITY: -520 }, "60 + 110 + 350 at cost");

    await asApp(c);
    await expectError(c, `select post_opening_stock($1, $2, $3, $4, null, $5, 'A1', null)`, [x.t, uuid(), x.store, JSON.stringify([lines[0]]), x.pharmacist], /PASSWORD_REQUIRED/);
    await expectError(c, `select post_opening_stock($1, $2, $3, $4, null, $5, 'A2', null)`, [x.t, uuid(), x.store, JSON.stringify([lines[0]]), x.other], /NO_STORE_ACCESS/);
    await expectError(c, `select post_opening_stock($1, $2, $3, $4, null, $5, 'A2', null)`, [x.t, uuid(), x.store, JSON.stringify([{ ...lines[0], expiry_date: null, batch_no: "NOEXP" }]), x.pharmacist], /EXPIRY_REQUIRED/);
    await expectError(c, `select post_opening_stock($1, $2, $3, $4, null, $5, 'A2', null)`, [x.t, uuid(), x.store, JSON.stringify([{ ...lines[0], expiry_date: "2027-04-30" }]), x.pharmacist], /BATCH_EXPIRY_MISMATCH/);
    await open(c, x, [{ ...lines[0], expiry_date: "2027-04-30", override_reason: "Label reprinted by the company" }]);
    await expectError(c, `select post_opening_stock($1, $2, $3, $4, null, $5, 'A2', null)`, [x.t, uuid(), x.store, JSON.stringify([{ ...lines[0], batch_no: "HI", sale_price: 25 }]), x.pharmacist], /PRICE_ABOVE_MRP/);
    await expectError(c, `insert into stock_movements (tenant_id, store_id, batch_id, item_id, qty_base, kind, unit_cost_base, posting_id, doc_type) select tenant_id, store_id, batch_id, item_id, 1, 'opening', 0, gen_random_uuid(), 'x' from stock_balances where tenant_id = $1 limit 1`, [x.t], /permission denied/);
    await expectError(c, `update stock_balances set qty_on_hand = 999 where tenant_id = $1`, [x.t], /permission denied/);
    await asOwner(c);
    await expectError(c, `update stock_movements set qty_base = 1 where tenant_id = $1`, [x.t], /APPEND_ONLY/);
  });
});

test("never negative; FEFO skips expired, blocked and short-dated lots; insufficient stock refused", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    const { rows: [{ id }] } = await save(c, x, PARA());
    const u = await units(c, id);
    const d = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await open(c, x, [
      { item_id: id, unit_id: u.tab, qty: 30, batch_no: "SOON", expiry_date: d(60), unit_cost: 1 },
      { item_id: id, unit_id: u.tab, qty: 50, batch_no: "LATER", expiry_date: d(400), unit_cost: 1 },
      { item_id: id, unit_id: u.tab, qty: 99, batch_no: "EXPIRED", expiry_date: d(-5), unit_cost: 1 },
      { item_id: id, unit_id: u.tab, qty: 99, batch_no: "BLOCKED", expiry_date: d(300), unit_cost: 1 },
      { item_id: id, unit_id: u.tab, qty: 99, batch_no: "SHORT", expiry_date: d(10), unit_cost: 1 },
    ]);
    await asOwner(c);
    await c.query(`update item_batches set status = 'blocked', blocked_at = now(), block_reason = 'Recall notice' where batch_no = 'BLOCKED' and item_id = $1`, [id]);
    await c.query(`update tenant_settings set min_sale_shelf_days = 30 where tenant_id = $1`, [x.t]);
    const take = async (q) => (await c.query(`select ib.batch_no, a.qty_base::numeric q from allocate_stock($1, $2, $3, $4, 'sale') a join item_batches ib on ib.id = a.batch_id`, [x.t, x.store, id, q])).rows.map((r) => [r.batch_no, Number(r.q)]);
    assert.deepEqual(await take(40), [["SOON", 30], ["LATER", 10]], "earliest expiry first, across lots");
    await expectError(c, `select * from allocate_stock($1, $2, $3, 81, 'sale')`, [x.t, x.store, id], /INSUFFICIENT_STOCK/);
    await expectError(c, `select * from allocate_stock($1, $2, $3, 1, 'sale')`, [x.t, x.quarantine, id], /STORE_NOT_SELLABLE/);
    // The CHECK on balances is the last line: no path can push a lot below zero.
    const { rows: [b] } = await c.query(`select batch_id from stock_balances sb join item_batches ib on ib.id = sb.batch_id where ib.batch_no = 'SOON' and ib.item_id = $1`, [id]);
    const { rows: [{ posting_id: pid }] } = await c.query(`select * from begin_posting($1, gen_random_uuid(), 'test', null, null, 'A2', null)`, [x.t]);
    await expectError(c, `insert into stock_movements (tenant_id, store_id, batch_id, item_id, qty_base, kind, unit_cost_base, posting_id, doc_type) values ($1, $2, $3, $4, -31, 'adjustment_out', 1, $5, 'test')`,
      [x.t, x.store, b.batch_id, id, pid], /stock_balances_qty_on_hand_check|check/);
    const stock = (await c.query(`select batch_no, expired, near_expiry from stock_by_batch($1, $2) order by batch_no`, [x.t, x.store])).rows;
    assert.deepEqual(stock.find((r) => r.batch_no === "EXPIRED"), { batch_no: "EXPIRED", expired: true, near_expiry: false });
    assert.equal(stock.find((r) => r.batch_no === "SOON").near_expiry, true, "within 90 days");
  });
});

test("ISOLATION: another clinic's items, units and stores are unreachable", async () => {
  await withTx(async (c) => {
    const a = await clinic(c), b = await clinic(c);
    await asApp(c);
    const { rows: [{ id: itemB }] } = await save(c, b, PARA());
    const uB = await units(c, itemB);
    await expectError(c, `select post_opening_stock($1, $2, $3, $4, null, $5, 'A2', null)`,
      [a.t, uuid(), a.store, JSON.stringify([{ item_id: itemB, unit_id: uB.tab, qty: 1, batch_no: "X", expiry_date: "2027-01-01", unit_cost: 1 }]), a.pharmacist], /ITEM_NOT_FOUND/);
    await expectError(c, `select post_opening_stock($1, $2, $3, $4, null, $5, 'A2', null)`,
      [a.t, uuid(), b.store, JSON.stringify([{ item_id: itemB, unit_id: uB.tab, qty: 1, batch_no: "X", expiry_date: "2027-01-01", unit_cost: 1 }]), a.admin], /NO_STORE_ACCESS/);
    await expectError(c, `select save_item($1, $2, $3, $4)`, [a.t, itemB, JSON.stringify(PARA({ barcodes: [] })), a.admin], /ITEM_NOT_FOUND/);
    assert.equal((await c.query(`select count(*)::int n from stock_by_batch($1, $2)`, [a.t, b.store])).rows[0].n, 0);
    await asOwner(c);
  });
});
