// B8a finance: expenses and other income (reversal only), openings, finance report, P&L, daily summary,
// carry-forward, the integrity check catching tampering, isolation.
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


// ── B8a finance ──
const expense = (c, x, cat, cash, online = 0, o = {}) => c.query(`select record_expense($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null) r`,
  [x.t, o.key ?? uuid(), cat, cash, online, o.channel ?? null, o.store ?? null, o.note ?? null, o.by ?? x.admin, o.level ?? "A1"]);
const today = async (c, t) => (await c.query(`select stock_today($1)::text d`, [t])).rows[0].d;
const shift = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

test("expenses and other income: journal both sides, corrected only by reversal; opening cash/bank once", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    const before = await acct(c, x.t);
    await asApp(c);
    const e1 = (await expense(c, x, "rent", 5000)).rows[0].r;
    assert.match(e1.expense_no, /^EXP-\d{5}$/);
    await expense(c, x, "electricity", 0, 1200, { channel: "esewa" });
    await expectError(c, `select record_expense($1, $2, 'other', 100, 0, null, null, null, $3, 'A1', null)`, [x.t, uuid(), x.admin], /NOTE_REQUIRED/);
    await expectError(c, `select record_expense($1, $2, 'rent', 100, 0, null, null, null, $3, 'A1', null)`, [x.t, uuid(), x.pharmacist], /NO_PERMISSION/);
    await expectError(c, `select record_other_income($1, $2, 'Scrap sale', 300, 0, null, $3, 'A1', null)`, [x.t, uuid(), x.admin], /PASSWORD_REQUIRED/);
    const inc = (await c.query(`select record_other_income($1, $2, 'Scrap cardboard sold', 0, 300, 'khalti', $3, 'A2', null) r`, [x.t, uuid(), x.admin])).rows[0].r;
    assert.match(inc.income_no, /^INC-\d{5}$/);
    await expectError(c, `select reverse_finance_entry($1, $2, 'expense', $3, 'Wrong amount', $4, 'A2', null, null)`, [x.t, uuid(), e1.expense_id, x.admin], /REAUTH_REQUIRED/);
    await c.query(`select reverse_finance_entry($1, $2, 'expense', $3, 'Wrong amount', $4, 'A2', now(), null)`, [x.t, uuid(), e1.expense_id, x.admin]);
    await expectError(c, `select reverse_finance_entry($1, $2, 'expense', $3, 'Again', $4, 'A2', now(), null)`, [x.t, uuid(), e1.expense_id, x.admin], /ALREADY_REVERSED/);
    await expense(c, x, "rent", 4500);
    await c.query(`select post_finance_opening($1, $2, 10000, 20000, current_date - 1, $3, 'A2', now(), null)`, [x.t, uuid(), x.admin]);
    await expectError(c, `select post_finance_opening($1, $2, 1, 0, current_date, $3, 'A2', now(), null)`, [x.t, uuid(), x.admin], /OPENING_EXISTS/);
    await asOwner(c);
    const after = await acct(c, x.t);
    const delta = (k) => Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 100) / 100;
    assert.deepEqual([delta("CASH"), delta("BANK"), delta("EXP_RENT"), delta("EXP_ELECTRICITY"), delta("REV_OTHER"), delta("OPENING_EQUITY")],
      [10000 - 4500, 20000 - 1200 + 300, 4500, 1200, -300, -30000], "the wrong rent cancelled, the right one stands");
    const { rows: [{ n }] } = await c.query(`select count(*)::int n from expenses where tenant_id = $1`, [x.t]);
    assert.equal(n, 3, "the original expense row is still there");
    await asApp(c);
    const v = (await c.query(`select verify_finance_integrity($1) r`, [x.t])).rows[0].r;
    assert.equal(v.mismatches, 0, JSON.stringify(v.checks));
    await asOwner(c);
  });
});

test("finance report, P&L and daily summary come from the journal; opening(T) = closing(T-1)", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    const d = await today(c, x.t);
    await asApp(c);
    await c.query(`select post_finance_opening($1, $2, 1000, 0, current_date, $3, 'A2', now(), null)`, [x.t, uuid(), x.admin]);
    await sell(c, x, [{ kind: "item", item_id: x.para, unit_id: x.u.strip, qty: 3 }], { cash: 65 });
    await expense(c, x, "cleaning", 100, 0, { store: x.store });
    await expense(c, x, "internet", 50);
    await c.query(`select record_other_income($1, $2, 'Bank interest', 0, 20, 'bank_transfer', $3, 'A2', null)`, [x.t, uuid(), x.admin]);
    const rep = (await c.query(`select finance_report($1, $2, $3) r`, [x.t, d, d])).rows[0].r;
    assert.deepEqual([rep.revenue_pharmacy, rep.cogs, rep.expenses, rep.other_income].map(Number), [65, 32, 150, 20]);
    assert.equal(Number(rep.balances.CASH.closing) - Number(rep.balances.CASH.opening), 1000 + 65 - 150, "cash moved by opening + sale − expenses");
    const pay = rep.money.find((m) => m.kind === "payment");
    assert.equal(Number(pay.cash_in), 65, "cash received from customers");
    assert.equal(Number(rep.online_by_channel.bank_transfer), 20);
    const prev = (await c.query(`select finance_report($1, $2, $3) r`, [x.t, shift(d, -7), shift(d, -1)])).rows[0].r;
    for (const k of Object.keys(rep.balances)) assert.equal(Number(prev.balances[k].closing), Number(rep.balances[k].opening), `${k}: opening today = closing yesterday`);
    const pl = (await c.query(`select profit_and_loss($1, null, $2, $3) r`, [x.t, d, d])).rows[0].r;
    assert.deepEqual([pl.revenue, pl.gross_profit, pl.net_profit].map(Number), [65, 33, 65 - 32 - 150 + 20]);
    const pls = (await c.query(`select profit_and_loss($1, $2, $3, $4) r`, [x.t, x.store, d, d])).rows[0].r;
    assert.deepEqual([pls.expenses, pls.other_income, pls.net_profit].map(Number), [100, 0, 65 - 32 - 100], "store view: only what is tagged to the store");
    const ds = (await c.query(`select daily_summary($1, $2) r`, [x.t, d])).rows[0].r;
    assert.deepEqual([ds.bills, ds.sales, ds.collected, ds.expenses].map(Number), [1, 65, 65, 150]);
    await expectError(c, `select finance_report($1, $2, $3)`, [x.t, d, shift(d, -1)], /BAD_PERIOD/);
    await asOwner(c);
  });
});

test("integrity check catches a document without its journal, logs it, repairs nothing", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    await asApp(c);
    await expense(c, x, "water", 300);
    assert.equal((await c.query(`select verify_finance_integrity($1) r`, [x.t])).rows[0].r.mismatches, 0);
    await asOwner(c);
    // tamper: an expense row whose posting has no journal lines
    const { rows: [p] } = await c.query(`select posting_id from begin_posting($1, $2, 'expense', $3, $4, 'A2', null)`, [x.t, uuid(), uuid(), x.admin]);
    await c.query(`insert into expenses (tenant_id, expense_no, fiscal_year, category, amount, cash_amount, recorded_by, posting_id) values ($1, 'EXP-99999', '2083/84', 'other', 500, 500, $2, $3)`, [x.t, x.admin, p.posting_id]);
    await asApp(c);
    const v = (await c.query(`select verify_finance_integrity($1) r`, [x.t])).rows[0].r;
    assert.equal(v.mismatches, 1);
    const cash = v.checks.find((k) => k.check === "cash");
    assert.equal(Number(cash.journal) - Number(cash.documents), 500, "documents say Rs. 500 more went out than the journal shows");
    await asOwner(c);
    assert.equal((await c.query(`select count(*)::int n from audit_log where tenant_id = $1 and action = 'finance.integrity' and outcome = 'error'`, [x.t])).rows[0].n, 1);
    const all = (await c.query(`select reconcile_all_tenants() r`)).rows[0].r;
    assert.ok(all.tenants.some((t) => t.tenant === x.t && t.finance_mismatches === 1), "the nightly job reports it too");
  });
});

test("ISOLATION: finance figures never include another clinic", async () => {
  await withTx(async (c) => {
    const a = await counter(c), b = await counter(c);
    const d = await today(c, a.t);
    await asApp(c);
    await expense(c, b, "rent", 9999);
    await expectError(c, `select record_expense($1, $2, 'rent', 1, 0, null, $3, null, $4, 'A1', null)`, [a.t, uuid(), b.store, a.admin], /STORE_NOT_FOUND/);
    await expectError(c, `select reverse_finance_entry($1, $2, 'expense', (select id from expenses where tenant_id = $3 limit 1), 'x y z', $4, 'A2', now(), null)`, [a.t, uuid(), b.t, a.admin], /NOT_FOUND|permission/);
    const rep = (await c.query(`select finance_report($1, $2, $2) r`, [a.t, d])).rows[0].r;
    assert.equal(Number(rep.expenses), 0);
    await asOwner(c);
  });
});
