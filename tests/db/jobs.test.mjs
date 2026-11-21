// B9b daily jobs: stock scan notification, subscription-ending warning, sign-in record housekeeping.
// RPCs run as service_role, like the app.
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


// ── B9b daily stock scan, subscription warning, housekeeping ──
test("daily stock scan: one notification a day to stock managers, counts only", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    await c.query(`update tenants set status = 'active' where id = $1`, [x.t]);
    await asApp(c);
    const r1 = (await c.query(`select run_daily_jobs($1) r`, [x.t])).rows[0].r;
    const r2 = (await c.query(`select run_daily_jobs($1) r`, [x.t])).rows[0].r;
    await asOwner(c);
    assert.ok(r1.stock_notified >= 1, "the expired batch OLD triggers it");
    assert.equal(r2.stock_notified, 0, "not again the same day");
    const { rows: [n] } = await c.query(`select title, body, link from notifications where member_id = $1 and kind = 'stock_alerts'`, [x.admin]);
    assert.equal(n.title, "Stock needs attention");
    assert.match(n.body, /1 expired batch still on hand/);
    assert.ok(!/Paracetamol|OLD/.test(n.body), "counts only, the screen has the detail");
    assert.equal(n.link, "/admin/reports?r=expiry");
    assert.equal((await c.query(`select count(*)::int n from notifications where member_id = $1 and kind = 'stock_alerts'`, [x.pharmacist])).rows[0].n, 0, "only people who manage stock");
  });
});

test("subscription ending within a week → admins told once per date; housekeeping prunes old sign-in records", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    await c.query(`update tenants set status = 'active' where id = $1`, [x.t]);
    const { rows: [pl] } = await c.query(`insert into plans (code, name, price_npr, billing_cycle_days) values ($1, 'Test plan', 0, 30) returning id`, [`p-${uuid().slice(0, 8)}`]);
    await c.query(`insert into tenant_subscriptions (tenant_id, plan_id, starts_on, ends_on, source) values ($1, $2, current_date - 25, current_date + 5, 'trial')`, [x.t, pl.id]);
    await c.query(`insert into pin_attempts (tenant_id, success, at) values ($1, false, now() - interval '100 days'), ($1, false, now())`, [x.t]);
    await asApp(c);
    const r = (await c.query(`select run_daily_jobs($1) r`, [x.t])).rows[0].r;
    assert.equal(r.subscription_warned, 1, "the clinic admin");
    assert.equal((await c.query(`select run_daily_jobs($1) r`, [x.t])).rows[0].r.subscription_warned, 0, "once per paid-until date");
    await asOwner(c);
    const { rows: [n] } = await c.query(`select body from notifications where member_id = $1 and kind = 'subscription_ending'`, [x.admin]);
    assert.match(n.body, /paid until/);
    const p = (await c.query(`select prune_sign_in_records() r`)).rows[0].r;
    assert.ok(p.pin_attempts >= 1);
    assert.equal((await c.query(`select count(*)::int n from pin_attempts where tenant_id = $1`, [x.t])).rows[0].n, 1, "recent attempts kept");
  });
});
