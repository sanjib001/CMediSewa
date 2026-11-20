// B5b stock operations: transfers (with transit loss), adjustments, counts (variance as of the
// counting moment), block/recall, disposal from quarantine, isolation. RPCs run as service_role.
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


// ── B5b stock operations: transfers, adjustments, counts, block/recall, disposal ──
const d = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
async function stocked(c) {
  const x = await clinic(c);
  await asApp(c);
  const { rows: [{ id }] } = await save(c, x, PARA({ barcodes: [] }));
  const u = await units(c, id);
  await open(c, x, [
    { item_id: id, unit_id: u.tab, qty: 50, batch_no: "GOOD", expiry_date: d(300), unit_cost: 2 },
    { item_id: id, unit_id: u.tab, qty: 20, batch_no: "OLD", expiry_date: d(-3), unit_cost: 2 },
  ], { by: x.admin });
  await asOwner(c);
  const lot = async (b) => (await c.query(`select id from item_batches where item_id = $1 and batch_no = $2`, [id, b])).rows[0].id;
  return { ...x, item: id, u, good: await lot("GOOD"), old: await lot("OLD") };
}
const qty = async (c, store, batch) => Number((await c.query(`select coalesce(sum(qty_on_hand), 0) q from stock_balances where store_id = $1 and batch_id = $2`, [store, batch])).rows[0].q);
const acct = async (c, t) => Object.fromEntries((await c.query(`select account_code a, sum(debit - credit)::numeric n from ledger_entries where tenant_id = $1 group by 1`, [t])).rows.map((r) => [r.a, Number(r.n)]));
const lines1 = (x, o) => JSON.stringify([{ item_id: x.item, unit_id: x.u.tab, ...o }]);

test("transfers: expired lot to quarantine with a transit loss; balances and journal exact; rules", async () => {
  await withTx(async (c) => {
    const x = await stocked(c);
    await asApp(c);
    const tr = (await c.query(`select request_transfer($1, $2, $3, $4, $5, 'Expired to quarantine') id`, [x.t, x.admin, x.store, x.quarantine, lines1(x, { qty: 20, batch_id: x.old })])).rows[0].id;
    await asOwner(c);
    assert.equal((await c.query(`select status from stock_transfers where id = $1`, [tr])).rows[0].status, "approved", "no approval step when the clinic doesn't require it");
    await asApp(c);
    const key = uuid();
    await c.query(`select dispatch_transfer($1, $2, $3, $4, 'A1', null)`, [x.t, key, tr, x.admin]);
    await c.query(`select dispatch_transfer($1, $2, $3, $4, 'A1', null)`, [x.t, key, tr, x.admin]);
    await asOwner(c);
    assert.equal(await qty(c, x.store, x.old), 0);
    assert.equal((await acct(c, x.t)).INVENTORY_IN_TRANSIT, 40);
    const { rows: [line] } = await c.query(`select id from stock_transfer_lines where transfer_id = $1`, [tr]);
    await asApp(c);
    await expectError(c, `select receive_transfer($1, $2, $3, $4, $5, 'A1', null)`, [x.t, uuid(), tr, JSON.stringify([{ line_id: line.id, received_base_qty: 15 }]), x.admin], /RECEIVE_MUST_MATCH/);
    await expectError(c, `select receive_transfer($1, $2, $3, $4, $5, 'A1', null)`, [x.t, uuid(), tr, JSON.stringify([{ line_id: line.id, received_base_qty: 18, loss_base_qty: 2 }]), x.admin], /LOSS_REASON_REQUIRED/);
    await c.query(`select receive_transfer($1, $2, $3, $4, $5, 'A1', null)`, [x.t, uuid(), tr, JSON.stringify([{ line_id: line.id, received_base_qty: 18, loss_base_qty: 2, loss_reason: "Broken in transit" }]), x.admin]);
    await asOwner(c);
    assert.equal(await qty(c, x.quarantine, x.old), 18);
    const j = await acct(c, x.t);
    assert.equal(j.INVENTORY_IN_TRANSIT, 0, "transit nets to zero");
    assert.equal(j.INV_LOSS, 4, "2 tabs at Rs. 2 lost");
    assert.equal(j.INVENTORY, 136, "100 good + 36 in quarantine");

    const { rows: [main] } = await c.query(`insert into stores (tenant_id, code, name, kind, is_sellable, is_receiving) values ($1, 'MAIN', 'Main store', 'main', true, true) returning id`, [x.t]);
    await asApp(c);
    const bad = (await c.query(`select request_transfer($1, $2, $3, $4, $5, null) id`, [x.t, x.admin, x.quarantine, main.id, lines1(x, { qty: 5, batch_id: x.old })])).rows[0].id;
    await expectError(c, `select dispatch_transfer($1, $2, $3, $4, 'A1', null)`, [x.t, uuid(), bad, x.admin], /LOT_NOT_SELLABLE/);
    const fefo = (await c.query(`select request_transfer($1, $2, $3, $4, $5, null) id`, [x.t, x.admin, x.store, main.id, JSON.stringify([{ item_id: x.item, unit_id: x.u.strip, qty: 3 }])])).rows[0].id;
    await c.query(`select dispatch_transfer($1, $2, $3, $4, 'A1', null)`, [x.t, uuid(), fefo, x.admin]);
    await c.query(`select receive_transfer($1, $2, $3, null, $4, 'A1', null)`, [x.t, uuid(), fefo, x.admin]);
    await asOwner(c);
    assert.equal(await qty(c, main.id, x.good), 30, "3 strips taken from the good lot (FEFO skips the expired one)");
    await c.query(`update tenant_settings set transfer_approval_required = true where tenant_id = $1`, [x.t]);
    await asApp(c);
    const ap = (await c.query(`select request_transfer($1, $2, $3, $4, $5, null) id`, [x.t, x.admin, x.store, main.id, lines1(x, { qty: 1 })])).rows[0].id;
    await expectError(c, `select dispatch_transfer($1, $2, $3, $4, 'A1', null)`, [x.t, uuid(), ap, x.admin], /TRANSFER_NOT_APPROVED/);
    await expectError(c, `select decide_transfer($1, $2, $3, 'approve', null)`, [x.t, x.pharmacist, ap], /NO_PERMISSION/);
    await expectError(c, `select decide_transfer($1, $2, $3, 'reject', '')`, [x.t, x.admin, ap], /REASON_REQUIRED/);
    await c.query(`select decide_transfer($1, $2, $3, 'approve', null)`, [x.t, x.admin, ap]);
    await c.query(`select dispatch_transfer($1, $2, $3, $4, 'A1', null)`, [x.t, uuid(), ap, x.admin]);
    await asOwner(c);
  });
});

test("adjustments: losses and finds with reasons, posted to INV_LOSS / INV_GAIN; never below zero", async () => {
  await withTx(async (c) => {
    const x = await stocked(c);
    await asApp(c);
    const adj = (reason, lines, who = x.admin, level = "A2") => c.query(`select post_stock_adjustment($1, $2, $3, $4, null, $5, $6, $7, null) id`, [x.t, uuid(), x.store, reason, JSON.stringify(lines), who, level]);
    const bad = (reason, lines, re, who = x.admin, level = "A2") => expectError(c, `select post_stock_adjustment($1, $2, $3, $4, null, $5, $6, $7, null)`, [x.t, uuid(), x.store, reason, JSON.stringify(lines), who, level], re);
    await adj("damaged", [{ batch_id: x.good, qty_base: -5 }]);
    await bad("damaged", [{ batch_id: x.good, qty_base: 5 }], /BAD_QTY/);
    await bad("lost", [{ batch_id: x.good, qty_base: -500 }], /INSUFFICIENT_STOCK/);
    await bad("lost", [{ batch_id: x.good, qty_base: -1 }], /PASSWORD_REQUIRED/, x.admin, "A1");
    await bad("lost", [{ batch_id: x.good, qty_base: -1 }], /NO_PERMISSION|NO_STORE_ACCESS/, x.other);
    await adj("found", [{ item_id: x.item, unit_id: x.u.strip, qty: 2, batch_no: "FOUND1", expiry_date: d(200), unit_cost: 20 }]);
    await asOwner(c);
    assert.equal(await qty(c, x.store, x.good), 45);
    const { rows: [f] } = await c.query(`select id, source from item_batches where batch_no = 'FOUND1'`);
    assert.equal(f.source, "found");
    assert.equal(await qty(c, x.store, f.id), 20);
    const j = await acct(c, x.t);
    assert.equal(j.INV_LOSS, 10);
    assert.equal(j.INV_GAIN, -40);
  });
});

test("counts: variance as of the counting moment; one open count per store; segregation", async () => {
  await withTx(async (c) => {
    const x = await stocked(c);
    await asApp(c);
    const k = (await c.query(`select start_stock_count($1, $2, $3, true, null) id`, [x.t, x.admin, x.store])).rows[0].id;
    await expectError(c, `select start_stock_count($1, $2, $3, true, null)`, [x.t, x.admin, x.store], /COUNT_ALREADY_OPEN/);
    await c.query(`select record_count($1, $2, $3, $4, 45, 'Strip found torn')`, [x.t, x.admin, k, x.good]);
    await c.query(`select post_stock_adjustment($1, $2, $3, 'internal_use', null, $4, $5, 'A2', null)`, [x.t, uuid(), x.store, JSON.stringify([{ batch_id: x.good, qty_base: -3 }]), x.admin]);
    await asOwner(c);
    await c.query(`update tenant_settings set count_post_requires_other_member = true where tenant_id = $1`, [x.t]);
    await asApp(c);
    await expectError(c, `select post_stock_count($1, $2, $3, $4, 'A2', null)`, [x.t, uuid(), k, x.admin], /OTHER_MEMBER_MUST_POST/);
    await asOwner(c);
    const admin2 = await member(c, x.t, true);
    await asApp(c);
    await c.query(`select post_stock_count($1, $2, $3, $4, 'A2', null)`, [x.t, uuid(), k, admin2]);
    await asOwner(c);
    assert.equal(await qty(c, x.store, x.good), 42, "50, minus 3 used after counting, minus 5 short = 42 (not 45)");
    assert.equal(Number((await c.query(`select variance from stock_count_lines where count_id = $1`, [k])).rows[0].variance), -5);
  });
});

test("block / recall in every store, reason required, history kept; disposal only from quarantine", async () => {
  await withTx(async (c) => {
    const x = await stocked(c);
    await asApp(c);
    await expectError(c, `select set_batch_status($1, $2, $3, 'recalled', '', 'A2')`, [x.t, x.admin, x.good], /REASON_REQUIRED/);
    await c.query(`select set_batch_status($1, $2, $3, 'recalled', 'DDA recall notice', 'A2')`, [x.t, x.admin, x.good]);
    await asOwner(c);
    await expectError(c, `select * from allocate_stock($1, $2, $3, 1, 'sale')`, [x.t, x.store, x.item], /INSUFFICIENT_STOCK/);
    await asApp(c);
    await c.query(`select set_batch_status($1, $2, $3, 'active', 'Recall withdrawn', 'A2')`, [x.t, x.admin, x.good]);
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from batch_status_history where batch_id = $1`, [x.good])).rows[0].n, 2);
    assert.equal((await c.query(`select count(*)::int n from allocate_stock($1, $2, $3, 1, 'sale')`, [x.t, x.store, x.item])).rows[0].n, 1);
    await asApp(c);
    await expectError(c, `select post_disposal($1, $2, $3, 'incineration', null, 'Witness One', null, $4, $5, 'A2', null)`, [x.t, uuid(), x.store, JSON.stringify([{ batch_id: x.old, qty_base: 5 }]), x.admin], /DISPOSE_FROM_QUARANTINE/);
    const tr = (await c.query(`select request_transfer($1, $2, $3, $4, $5, null) id`, [x.t, x.admin, x.store, x.quarantine, lines1(x, { qty: 20, batch_id: x.old })])).rows[0].id;
    await c.query(`select dispatch_transfer($1, $2, $3, $4, 'A1', null)`, [x.t, uuid(), tr, x.admin]);
    await c.query(`select receive_transfer($1, $2, $3, null, $4, 'A1', null)`, [x.t, uuid(), tr, x.admin]);
    await c.query(`select post_disposal($1, $2, $3, 'authorised_contractor', 'Green Waste Pvt Ltd', 'Witness One', null, $4, $5, 'A2', null)`, [x.t, uuid(), x.quarantine, JSON.stringify([{ batch_id: x.old, qty_base: 20 }]), x.admin]);
    await asOwner(c);
    assert.equal(await qty(c, x.quarantine, x.old), 0);
    assert.equal((await acct(c, x.t)).INV_LOSS, 40);
  });
});

test("ISOLATION: no transfer, adjustment, count or block can touch another clinic's stores or lots", async () => {
  await withTx(async (c) => {
    const a = await stocked(c), b = await stocked(c);
    await asApp(c);
    await expectError(c, `select request_transfer($1, $2, $3, $4, $5, null)`, [a.t, a.admin, b.store, a.quarantine, JSON.stringify([{ item_id: b.item, unit_id: b.u.tab, qty: 1 }])], /NO_STORE_ACCESS|STORE_NOT_FOUND|ITEM_NOT_FOUND/);
    await expectError(c, `select post_stock_adjustment($1, $2, $3, 'lost', null, $4, $5, 'A2', null)`, [a.t, uuid(), a.store, JSON.stringify([{ batch_id: b.good, qty_base: -1 }]), a.admin], /LOT_NOT_FOUND/);
    const k = (await c.query(`select start_stock_count($1, $2, $3, true, null) id`, [a.t, a.admin, a.store])).rows[0].id;
    await expectError(c, `select record_count($1, $2, $3, $4, 1, null)`, [a.t, a.admin, k, b.good], /LOT_NOT_FOUND/);
    await expectError(c, `select set_batch_status($1, $2, $3, 'blocked', 'x', 'A2')`, [a.t, a.admin, b.good], /LOT_NOT_FOUND/);
    await expectError(c, `select start_stock_count($1, $2, $3, true, null)`, [a.t, a.admin, b.store], /NO_STORE_ACCESS/);
    await asOwner(c);
  });
});
