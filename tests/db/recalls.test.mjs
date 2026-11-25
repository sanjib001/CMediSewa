// M-51 bulk recall: one batch number of a medicine is recalled in every store at once (all its
// lots), can't be sold, staff are told, and the bills that sold it are listed with whom to
// contact. Permission, password session, isolation. RPCs run as service_role, like the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

async function authUser(c) {
  const id = uuid();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`, [id, `rc-${id.slice(0, 8)}@example.invalid`]);
  return id;
}
async function member(c, t, admin = false) {
  const { rows: [m] } = await c.query(`insert into tenant_members (tenant_id, auth_user_id, membership_role, display_name, email) values ($1, $2, $3, 'Staff', $4) returning id`,
    [t, await authUser(c), admin ? "tenant_admin" : "tenant_member", `m-${uuid().slice(0, 8)}@example.invalid`]);
  return m.id;
}
const d = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const asApp = (c) => c.query(`set role service_role`);
const asOwner = (c) => c.query(`reset role`);
const ITEM = (name) => ({
  item_type: "medicine", name, generic: "Paracetamol", strength_value: 500, strength_unit: "mg", dosage_form: "tablet", route: "oral",
  schedule_class: "otc", manufacturer: "Nepal Pharmaceuticals", category: "Analgesics", reorder_level: 0, min_stock_level: 0,
  units: [{ name: "tab", factor: 1, is_base: true }], barcodes: [], default_purchase_unit: "tab", default_sale_unit: "tab",
});

/** Two sellable stores; "B123" of Cetamol is in both (two lots), "B999" only in the main one; another medicine also has a "B123". */
async function clinic(c) {
  const t = await makeTenant(c);
  await c.query(`update tenants set status = 'active' where id = $1`, [t]);
  const { rows: [bp] } = await c.query(`insert into billing_profiles (tenant_id, name, legal_name, is_default) values ($1, 'C', 'C Ltd', true) returning id`, [t]);
  await c.query(`insert into tenant_settings (tenant_id, default_billing_profile_id) values ($1, $2)`, [t, bp.id]);
  const store = async (code) => (await c.query(`insert into stores (tenant_id, code, name, kind, billing_profile_id, is_sellable, is_dispensing, is_receiving) values ($1, $2, $2, 'pharmacy', $3, true, true, true) returning id`, [t, code, bp.id])).rows[0].id;
  const main = await store("MAIN"), branch = await store("BRANCH");
  const admin = await member(c, t, true), seller = await member(c, t);
  const { rows: [r] } = await c.query(`insert into tenant_roles (tenant_id, name, permissions) values ($1, 'Counter', $2) returning id`, [t, ["pharmacy_sell", "all_stores", "view_stock"]]);
  await c.query(`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [t, seller, r.id]);
  await asApp(c);
  const item = (await c.query(`select save_item($1, null, $2, $3) id`, [t, JSON.stringify(ITEM("Cetamol 500")), admin])).rows[0].id;
  const other = (await c.query(`select save_item($1, null, $2, $3) id`, [t, JSON.stringify(ITEM("Febrex 500")), admin])).rows[0].id;
  const tab = async (i) => (await c.query(`select id from item_units where item_id = $1`, [i])).rows[0].id;
  const open = (s, lines) => c.query(`select post_opening_stock($1, $2, $3, $4, null, $5, 'A2', null)`, [t, uuid(), s, JSON.stringify(lines), admin]);
  const ut = await tab(item), uo = await tab(other);
  await open(main, [{ item_id: item, unit_id: ut, qty: 20, batch_no: "B123", expiry_date: d(300), unit_cost: 1, mrp: 2 },
                    { item_id: item, unit_id: ut, qty: 50, batch_no: "B999", expiry_date: d(400), unit_cost: 1, mrp: 2 },
                    { item_id: other, unit_id: uo, qty: 10, batch_no: "B123", expiry_date: d(300), unit_cost: 1, mrp: 2 }]);
  await open(branch, [{ item_id: item, unit_id: ut, qty: 30, batch_no: "B123", expiry_date: d(300), unit_cost: 1, mrp: 2 }]);
  await asOwner(c);
  const { rows: [p] } = await c.query(`insert into patients (tenant_id, full_name, sex, age_years, phone) values ($1, 'Kamala Rai', 'female', 52, '9841000001') returning id`, [t]);
  return { t, main, branch, admin, seller, item, other, ut, uo, patient: p.id };
}
const sell = (c, x, o) => c.query(`select issue_counter_sale($1, $2, $3, $4, $5, $6, $7, null, $8, 0, null, null, $9, 'A1', null) r`,
  [x.t, uuid(), o.store ?? x.main, o.patient ?? null, o.name ?? null, o.phone ?? null, JSON.stringify(o.lines), o.cash, x.seller]).then((r) => r.rows[0].r);
const recall = (c, x, batch = "b123", by = x.admin, level = "A2", item = x.item) =>
  c.query(`select recall_batch($1, $2, $3, $4, 'Maker recall: wrong strength', 'DDA-2083-17', $5) r`, [x.t, by, item, batch, level]).then((r) => r.rows[0].r);

test("recall: every lot of that batch, in every store, at once; no more sales; staff told; audited", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    // sell 10 tabs to a patient and 5 to a walk-in, all from B123 (earliest expiry first)
    await sell(c, x, { patient: x.patient, lines: [{ kind: "item", item_id: x.item, unit_id: x.ut, qty: 10 }], cash: 20 });
    await sell(c, x, { name: "Ram Walk-in", phone: "9800000099", lines: [{ kind: "item", item_id: x.item, unit_id: x.ut, qty: 5 }], cash: 10 });
    await expectError(c, `select recall_batch($1, $2, $3, 'B123', 'Maker recall', null, 'A2')`, [x.t, x.seller, x.item], /NO_PERMISSION/);
    await expectError(c, `select recall_batch($1, $2, $3, 'B123', 'Maker recall', null, 'A1')`, [x.t, x.admin, x.item], /PASSWORD_REQUIRED/);
    await expectError(c, `select recall_batch($1, $2, $3, 'NOPE1', 'Maker recall', null, 'A2')`, [x.t, x.admin, x.item], /BATCH_NOT_FOUND/);
    await expectError(c, `select recall_batch($1, $2, $3, 'B123', '', null, 'A2')`, [x.t, x.admin, x.item], /REASON_REQUIRED/);
    const r = await recall(c, x, " b123 ");
    assert.deepEqual([r.lots, Number(r.on_hand_base), r.bills], [2, 35, 2], "two lots (main + branch), 5 + 30 left, two bills");
    await asOwner(c);
    const st = (await c.query(`select b.batch_no, i.name, b.status from item_batches b join inventory_items i on i.id = b.item_id where b.tenant_id = $1 order by i.name, b.batch_no, b.status`, [x.t])).rows
      .map((b) => `${b.name}/${b.batch_no}:${b.status}`);
    assert.deepEqual(st, ["Cetamol 500/B123:recalled", "Cetamol 500/B123:recalled", "Cetamol 500/B999:active", "Febrex 500/B123:active"], "only this medicine's batch");
    assert.equal((await c.query(`select count(*)::int n from batch_status_history where tenant_id = $1 and new_status = 'recalled'`, [x.t])).rows[0].n, 2);
    await asApp(c);
    const again = await recall(c, x);
    assert.equal(again.lots, 2, "recalling again lists the lots, already recalled");
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from batch_status_history where tenant_id = $1 and new_status = 'recalled'`, [x.t])).rows[0].n, 2, "no duplicate history");
  });
});

test("recall: the recalled lot is never sold again; notifications go to stock managers and sellers", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    const r = await recall(c, x);
    // the main store still has B999, so a sale there takes B999 only
    const s = await sell(c, x, { lines: [{ kind: "item", item_id: x.item, unit_id: x.ut, qty: 3 }], cash: 6 });
    await expectError(c, `select issue_counter_sale($1, $2, $3, null, null, null, $4, null, 2, 0, null, null, $5, 'A1', null)`,
      [x.t, uuid(), x.branch, JSON.stringify([{ kind: "item", item_id: x.item, unit_id: x.ut, qty: 1 }]), x.seller], /./);
    await asOwner(c);
    const lots = (await c.query(`select b.batch_no from invoice_line_allocations a join item_batches b on b.id = a.batch_id join invoice_lines l on l.id = a.invoice_line_id where l.invoice_id = $1`, [s.invoice_id])).rows.map((b) => b.batch_no);
    assert.deepEqual(lots, ["B999"]);
    const n = (await c.query(`select member_id, link, title from notifications where tenant_id = $1 and kind = 'batch_recall'`, [x.t])).rows;
    assert.equal(n.find((m) => m.member_id === x.admin)?.link, `/admin/stock/recalls/${r.recall_id}`);
    assert.equal(n.find((m) => m.member_id === x.seller)?.link, "/employee/pharmacy?tab=stock");
    assert.ok(n.every((m) => m.title === "Recall: Cetamol 500"));
    const { rows: [au] } = await c.query(`select reason, detail from audit_log where tenant_id = $1 and action = 'batch.bulk_recall'`, [x.t]);
    assert.equal(au.reason, "Maker recall: wrong strength"); assert.equal(au.detail.reference, "DDA-2083-17");
  });
});

test("who bought it: each bill with the patient or walk-in contact, net of returns; read is audited", async () => {
  await withTx(async (c) => {
    const x = await clinic(c);
    await asApp(c);
    await sell(c, x, { patient: x.patient, lines: [{ kind: "item", item_id: x.item, unit_id: x.ut, qty: 10 }], cash: 20 });
    await sell(c, x, { name: "Ram Walk-in", phone: "9800000099", lines: [{ kind: "item", item_id: x.item, unit_id: x.ut, qty: 5 }], cash: 10 });
    await sell(c, x, { lines: [{ kind: "item", item_id: x.other, unit_id: x.uo, qty: 2 }], cash: 4 });
    const r = await recall(c, x);
    await expectError(c, `select * from recall_affected_sales($1, $2, $3, 'A2')`, [x.t, x.seller, r.recall_id], /NO_PERMISSION/);
    const rows = (await c.query(`select * from recall_affected_sales($1, $2, $3, 'A2')`, [x.t, x.admin, r.recall_id])).rows;
    assert.equal(rows.length, 2, "the other medicine's B123 isn't included");
    const byName = Object.fromEntries(rows.map((s) => [s.patient_name ?? s.customer_name, s]));
    assert.equal(Number(byName["Kamala Rai"].qty_sold_base), 10); assert.equal(byName["Kamala Rai"].phone, "9841000001");
    assert.equal(Number(byName["Ram Walk-in"].qty_sold_base), 5); assert.equal(byName["Ram Walk-in"].phone, "9800000099");
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from audit_log where tenant_id = $1 and action = 'batch.recall_sales_read'`, [x.t])).rows[0].n, 1);
  });
});

test("ISOLATION: another clinic can't recall this medicine or read who bought it", async () => {
  await withTx(async (c) => {
    const x = await clinic(c), y = await clinic(c);
    await asApp(c);
    await expectError(c, `select recall_batch($1, $2, $3, 'B123', 'Maker recall', null, 'A2')`, [y.t, y.admin, x.item], /ITEM_NOT_FOUND/);
    const r = await recall(c, x);
    await expectError(c, `select * from recall_affected_sales($1, $2, $3, 'A2')`, [y.t, y.admin, r.recall_id], /RECALL_NOT_FOUND/);
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from item_batches where tenant_id = $1 and status = 'recalled'`, [y.t])).rows[0].n, 0);
  });
});
