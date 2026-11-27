// 0068 Other sales (D-158): typed-in lines (lab tests, ...) under a bill title, no stock, no VAT,
// posted to REV_OTHER; only for members holding "other_sales". RPCs run as service_role, like the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

async function member(c, t) {
  const id = uuid();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`, [id, `os-${id.slice(0, 8)}@example.invalid`]);
  const { rows: [m] } = await c.query(`insert into tenant_members (tenant_id, auth_user_id, membership_role, display_name, email) values ($1, $2, 'tenant_member', 'Staff', $3) returning id`,
    [t, id, `os-${id.slice(0, 8)}@example.invalid`]);
  return m.id;
}
async function counter(c) {
  const t = await makeTenant(c);
  await c.query(`update tenants set status = 'active' where id = $1`, [t]);
  const { rows: [bp] } = await c.query(`insert into billing_profiles (tenant_id, name, legal_name, is_default) values ($1, 'C', 'C Ltd', true) returning id`, [t]);
  await c.query(`insert into tenant_settings (tenant_id, default_billing_profile_id) values ($1, $2)`, [t, bp.id]);
  const { rows: [st] } = await c.query(`insert into stores (tenant_id, code, name, kind, billing_profile_id, is_sellable, is_dispensing, is_receiving) values ($1, 'PHARM', 'Pharmacy', 'pharmacy', $2, true, true, true) returning id`, [t, bp.id]);
  const withKey = await member(c, t), without = await member(c, t);
  for (const [m, keys] of [[withKey, ["pharmacy_sell", "other_sales"]], [without, ["pharmacy_sell"]]]) {
    const { rows: [r] } = await c.query(`insert into tenant_roles (tenant_id, name, permissions) values ($1, $2, $3) returning id`, [t, `R-${uuid().slice(0, 6)}`, keys]);
    await c.query(`insert into member_roles (tenant_id, member_id, role_id) values ($1, $2, $3)`, [t, m, r.id]);
    await c.query(`insert into store_members (tenant_id, store_id, member_id, access) values ($1, $2, $3, 'manage')`, [t, st.id, m]);
  }
  return { t, store: st.id, withKey, without };
}
const SELL = `select issue_counter_sale($1, $2, $3, null, $4, null, $5, null, $6, 0, null, null, $7, 'A1', null, $8) r`;
const args = (x, lines, o = {}) => [x.t, o.key ?? uuid(), x.store, o.name ?? null, JSON.stringify(lines), o.cash ?? 0, o.by ?? x.withKey, o.title ?? null];
const sell = (c, x, lines, o = {}) => c.query(SELL, args(x, lines, o));

test("other sales: typed-in lines under a title, paid in full, no VAT, booked as other income", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    await c.query(`set role service_role`);
    const { rows: [{ r }] } = await sell(c, x, [
      { kind: "other", description: "CBC test", qty: 1, unit_price: 450 },
      { kind: "other", description: "Blood sugar (fasting)", qty: 2, unit_price: 150.5, discount_pct: 10 },
    ], { title: "Lab", name: "Ram Thapa", cash: 720.9 });
    await c.query(`reset role`);
    assert.equal(Number(r.total), 720.9);           // 450 + 301 - 30.10
    const { rows: [inv] } = await c.query(`select title, tax_total, customer_name from invoices where id = $1`, [r.invoice_id]);
    assert.deepEqual([inv.title, Number(inv.tax_total), inv.customer_name], ["Lab", 0, "Ram Thapa"]);
    const lines = (await c.query(`select line_type, description, qty::numeric q, unit_price::numeric p, line_total::numeric t from invoice_lines where invoice_id = $1 order by line_no`, [r.invoice_id])).rows;
    assert.deepEqual(lines.map((l) => [l.line_type, l.description, Number(l.q), Number(l.p), Number(l.t)]),
      [["other", "CBC test", 1, 450, 450], ["other", "Blood sugar (fasting)", 2, 150.5, 270.9]]);
    const led = Object.fromEntries((await c.query(`select account_code a, sum(credit - debit)::numeric n from ledger_entries where tenant_id = $1 group by 1`, [x.t])).rows.map((e) => [e.a, Number(e.n)]));
    assert.equal(led.REV_OTHER, 720.9);
    assert.equal(led.REV_PHARMACY ?? 0, 0);
    assert.equal(led.CASH, -720.9);
  });
});

test("other sales: needs the permission, a description and a sane price and title", async () => {
  await withTx(async (c) => {
    const x = await counter(c);
    await c.query(`set role service_role`);
    await expectError(c, SELL, args(x, [{ kind: "other", description: "X-ray", qty: 1, unit_price: 500 }], { by: x.without, cash: 500 }), /NO_PERMISSION_OTHER_SALES/);
    await expectError(c, SELL, args(x, [{ kind: "other", description: "  ", qty: 1, unit_price: 500 }], { cash: 500 }), /BAD_DESCRIPTION/);
    await expectError(c, SELL, args(x, [{ kind: "other", description: "X-ray", qty: 1, unit_price: -5 }]), /BAD_PRICE/);
    await expectError(c, SELL, args(x, [{ kind: "other", description: "X-ray", qty: 0, unit_price: 5 }]), /BAD_QTY/);
    await expectError(c, SELL, args(x, [{ kind: "other", description: "X-ray", qty: 1, unit_price: 500 }], { title: "x".repeat(61), cash: 500 }), /BAD_TITLE/);
    // a walk-in pays in full
    await expectError(c, SELL, args(x, [{ kind: "other", description: "X-ray", qty: 1, unit_price: 500 }], { cash: 100 }), /PATIENT_REQUIRED_FOR_DUE/);
  });
});
