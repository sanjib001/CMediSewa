// Posting core behaviour: idempotency, gapless numbering per fiscal year, balanced and
// immutable journal, single reversal. database.md §11.6, §12; D-43, D-44, D-45.
// Primitives are called as the migrating role here: in production only document RPCs
// owned by ledger_writer can call them (proven in access.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant, uuid } from "./helpers.mjs";

const entries = (lines) => JSON.stringify(lines);
const cashSale = (amount) => entries([
  { account: "CASH", debit: amount, channel: "cash" },
  { account: "REV_SERVICES", credit: amount },
]);

async function begin(c, tenant, key = uuid(), docType = "test_doc") {
  const { rows } = await c.query(
    `select posting_id, replayed from begin_posting($1, $2, $3, $4, null, 'A1', null)`,
    [tenant, key, docType, uuid()]);
  return rows[0];
}

test("fiscal_year_of follows the Kathmandu calendar date, not UTC", async () => {
  await withTx(async (c) => {
    const fy = async (ts) => (await c.query(`select fiscal_year_of($1::timestamptz) v`, [ts])).rows[0].v;
    // 1 Shrawan 2083 = 2026-07-17. Kathmandu is UTC+05:45, so local midnight = 18:15 UTC the day before.
    assert.equal(await fy("2026-07-16T18:14:59Z"), "2082/83");
    assert.equal(await fy("2026-07-16T18:15:00Z"), "2083/84");
    assert.equal(await fy("2025-07-17T00:00:00+05:45"), "2082/83");
    await expectError(c, `select fiscal_year_of('2040-01-01T00:00:00Z')`, [], /FISCAL_YEAR_UNKNOWN/);
  });
});

test("every new tenant gets the full system chart of accounts", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const { rows } = await c.query(`select code from ledger_accounts where tenant_id = $1 order by code`, [t]);
    const codes = rows.map((r) => r.code);
    for (const required of ["CASH", "BANK", "AR_PATIENTS", "AP_VENDORS", "INVENTORY", "COGS", "REV_SERVICES", "REV_PHARMACY", "OPENING_EQUITY"]) {
      assert.ok(codes.includes(required), `missing ${required}`);
    }
  });
});

test("document numbers are gapless, per scope and per fiscal year, and a rollback releases the number", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const { rows: [p] } = await c.query(
      `insert into billing_profiles (tenant_id, name, legal_name, is_default) values ($1, 'Clinic', 'Test Clinic Pvt Ltd', true) returning id`, [t]);
    const next = async (at, scope = p.id, type = "invoice") =>
      (await c.query(`select fiscal_year, doc_no from next_document_no($1, $2, $3, $4)`, [t, type, scope, at])).rows[0];

    const inFy = "2026-01-10T10:00:00+05:45";
    assert.deepEqual(await next(inFy), { fiscal_year: "2082/83", doc_no: "1" });
    assert.deepEqual(await next(inFy), { fiscal_year: "2082/83", doc_no: "2" });

    // A failed document must not burn a number.
    await c.query(`savepoint sp`);
    assert.equal((await next(inFy)).doc_no, "3");
    await c.query(`rollback to savepoint sp`);
    assert.equal((await next(inFy)).doc_no, "3");

    // New fiscal year → new series. Other doc types and scopes are independent.
    assert.deepEqual(await next("2026-07-20T10:00:00+05:45"), { fiscal_year: "2083/84", doc_no: "1" });
    assert.equal((await next(inFy, t, "purchase")).doc_no, "1");

    // A scope id from another tenant is refused.
    const other = await makeTenant(c);
    await expectError(c, `select * from next_document_no($1, 'invoice', $2)`, [other, p.id], /SCOPE_NOT_IN_TENANT/);
  });
});

test("begin_posting is idempotent and refuses a key reused for another document type", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const key = uuid();
    const first = await begin(c, t, key);
    const again = await begin(c, t, key);
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(again.posting_id, first.posting_id);
    await expectError(c, `select * from begin_posting($1, $2, 'other_doc', null, null, null, null)`, [t, key], /IDEMPOTENCY_KEY_REUSED/);
    // The same key in ANOTHER tenant is a different posting.
    const t2 = await makeTenant(c);
    assert.notEqual((await begin(c, t2, key)).posting_id, first.posting_id);
    await expectError(c, `select * from begin_posting($1, null, 'x', null, null, null, null)`, [t], /IDEMPOTENCY_KEY_REQUIRED/);
  });
});

test("post_journal accepts balanced entries once, and rejects unbalanced or short ones", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const p = await begin(c, t);
    await expectError(c, `select post_journal($1, $2, $3::jsonb)`, [t, p.posting_id,
      entries([{ account: "CASH", debit: 100 }, { account: "REV_SERVICES", credit: 99.99 }])], /UNBALANCED_POSTING/);
    await expectError(c, `select post_journal($1, $2, $3::jsonb)`, [t, p.posting_id,
      entries([{ account: "CASH", debit: 100 }])], /JOURNAL_NEEDS_TWO_LINES/);
    await expectError(c, `select post_journal($1, $2, $3::jsonb)`, [t, p.posting_id,
      entries([{ account: "CASH", debit: 100, credit: 100 }, { account: "REV_SERVICES", credit: 0 }])], /check constraint|23514/);
    await expectError(c, `select post_journal($1, $2, $3::jsonb)`, [t, p.posting_id,
      entries([{ account: "NOT_AN_ACCOUNT", debit: 5 }, { account: "CASH", credit: 5 }])], /23503|foreign key/);

    const { rows } = await c.query(`select post_journal($1, $2, $3::jsonb) n`, [t, p.posting_id, cashSale(500)]);
    assert.equal(rows[0].n, 2);
    await c.query(`set constraints all immediate`); // run the deferred balance check now
    await expectError(c, `select post_journal($1, $2, $3::jsonb)`, [t, p.posting_id, cashSale(1)], /POSTING_ALREADY_JOURNALED/);

    // A posting of tenant A cannot be journaled under tenant B.
    const t2 = await makeTenant(c);
    const p2 = await begin(c, t);
    await expectError(c, `select post_journal($1, $2, $3::jsonb)`, [t2, p2.posting_id, cashSale(1)], /POSTING_NOT_FOUND/);
  });
});

test("the deferred trigger rejects an unbalanced journal even when written directly", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const p = await begin(c, t);
    await c.query(
      `insert into ledger_entries (tenant_id, posting_id, account_code, debit, doc_type, occurred_at)
       values ($1, $2, 'CASH', 10, 'test_doc', now())`, [t, p.posting_id]);
    await expectError(c, `set constraints ledger_entries_balanced immediate`, [], /UNBALANCED_POSTING/);
  });
});

test("journal and postings are immutable; a reversal mirrors the original exactly once", async () => {
  await withTx(async (c) => {
    const t = await makeTenant(c);
    const p = await begin(c, t);
    await c.query(`select post_journal($1, $2, $3::jsonb)`, [t, p.posting_id, entries([
      { account: "CASH", debit: 300, channel: "cash" },
      { account: "BANK", debit: 200, channel: "esewa" },
      { account: "REV_PHARMACY", credit: 500 },
    ])]);
    await c.query(`set constraints all immediate`);

    await expectError(c, `update ledger_entries set debit = 1 where posting_id = $1`, [p.posting_id], /APPEND_ONLY/);
    await expectError(c, `delete from ledger_entries where posting_id = $1`, [p.posting_id], /APPEND_ONLY/);
    await expectError(c, `delete from postings where id = $1`, [p.posting_id], /APPEND_ONLY/);
    await expectError(c, `truncate ledger_entries`, [], /APPEND_ONLY/);

    await expectError(c, `select reverse_posting($1, $2, gen_random_uuid(), null, 'A2', null, '  ')`, [t, p.posting_id], /REASON_REQUIRED/);
    const key = uuid();
    const { rows: [r] } = await c.query(`select reverse_posting($1, $2, $3, null, 'A2', null, 'wrong patient') id`, [t, p.posting_id, key]);
    await c.query(`set constraints all immediate`);
    const { rows: [again] } = await c.query(`select reverse_posting($1, $2, $3, null, 'A2', null, 'wrong patient') id`, [t, p.posting_id, key]);
    assert.equal(again.id, r.id, "retrying the same reversal returns it");

    const bal = async (posting) => (await c.query(
      `select account_code, sum(debit - credit)::numeric net from ledger_entries where posting_id = $1 group by 1 order by 1`, [posting])).rows;
    const orig = await bal(p.posting_id);
    const rev = await bal(r.id);
    assert.deepEqual(rev.map((x) => [x.account_code, -Number(x.net)]), orig.map((x) => [x.account_code, Number(x.net)]));

    const { rows: [net] } = await c.query(
      `select coalesce(sum(debit - credit), 0)::numeric n from ledger_entries where tenant_id = $1 and account_code = 'CASH'`, [t]);
    assert.equal(Number(net.n), 0, "original + reversal nets to zero");

    await expectError(c, `select reverse_posting($1, $2, gen_random_uuid(), null, 'A2', null, 'again')`, [t, p.posting_id], /23505|duplicate key/);
    await expectError(c, `select reverse_posting($1, $2, gen_random_uuid(), null, 'A2', null, 'undo undo')`, [t, r.id], /CANNOT_REVERSE_REVERSAL/);
  });
});
