// Access posture, proven by behaviour (not just catalog inspection): what each role can
// actually do. security.md §4, §11, §12; decisions D-04, D-18, D-39.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, expectError, makeTenant } from "./helpers.mjs";
import { checkPosture } from "../../scripts/lib/posture.mjs";

test("posture rules all hold", async () => {
  await withTx(async (c) => {
    assert.deepEqual(await checkPosture(c), []);
  });
});

test("anon and authenticated cannot read or write any CMediSewa table", async () => {
  await withTx(async (c) => {
    for (const role of ["anon", "authenticated"]) {
      await c.query(`set local role ${role}`);
      for (const t of ["tenants", "tenant_settings", "billing_profiles", "audit_log", "postings", "ledger_entries"]) {
        await expectError(c, `select 1 from ${t} limit 1`, [], /permission denied/);
      }
      await expectError(c, `insert into tenants (slug, name) values ('x-anon', 'X')`, [], /permission denied/);
      await expectError(c, `select fiscal_year_of(now())`, [], /permission denied/);
      await c.query(`reset role`);
    }
  });
});

test("service_role reads and writes ordinary tables but never the ledger", async () => {
  await withTx(async (c) => {
    const tenant = await makeTenant(c);
    await c.query(`set local role service_role`);
    const { rows } = await c.query(`select count(*)::int n from ledger_accounts where tenant_id = $1`, [tenant]);
    assert.ok(rows[0].n > 20, "service_role can read the seeded chart of accounts");
    await c.query(`update tenants set phone = '01-5550000' where id = $1`, [tenant]);

    await expectError(c,
      `insert into postings (tenant_id, idempotency_key, doc_type) values ($1, gen_random_uuid(), 'test')`,
      [tenant], /permission denied/);
    await expectError(c,
      `insert into ledger_entries (tenant_id, posting_id, account_code, debit, doc_type, occurred_at)
       values ($1, gen_random_uuid(), 'CASH', 1, 'test', now())`, [tenant], /permission denied/);
    await expectError(c, `update document_sequences set next_no = 1`, [], /permission denied/);
    await expectError(c, `select * from post_journal($1, gen_random_uuid(), '[]'::jsonb)`, [tenant], /permission denied/);
    await expectError(c, `select * from begin_posting($1, gen_random_uuid(), 'x', null, null, null, null)`, [tenant], /permission denied/);
    await expectError(c, `select * from next_document_no($1, 'invoice', $1)`, [tenant], /permission denied/);
    await expectError(c, `delete from tenants where id = $1`, [tenant], /permission denied/);
    await expectError(c, `truncate tenants`, [], /permission denied/);
  });
});

test("audit_log is append-only for every role, including the table owner", async () => {
  await withTx(async (c) => {
    const tenant = await makeTenant(c);
    await c.query(`set local role service_role`);
    const { rows } = await c.query(
      `insert into audit_log (tenant_id, actor_kind, action, outcome) values ($1, 'system', 'test.event', 'success') returning id`,
      [tenant]);
    await expectError(c, `update audit_log set reason = 'x' where id = $1`, [rows[0].id], /permission denied/);
    await expectError(c, `delete from audit_log where id = $1`, [rows[0].id], /permission denied/);
    await c.query(`reset role`);
    // Even the owner is stopped by the trigger.
    await expectError(c, `update audit_log set reason = 'x' where id = $1`, [rows[0].id], /APPEND_ONLY/);
    await expectError(c, `delete from audit_log where id = $1`, [rows[0].id], /APPEND_ONLY/);
    await expectError(c, `truncate audit_log`, [], /APPEND_ONLY/);
  });
});

test("composite FKs make cross-tenant references impossible", async () => {
  await withTx(async (c) => {
    const a = await makeTenant(c);
    const b = await makeTenant(c);
    const { rows } = await c.query(
      `insert into billing_profiles (tenant_id, name, legal_name, is_default) values ($1, 'Clinic', 'B Clinic Pvt Ltd', true) returning id`, [b]);
    const profileOfB = rows[0].id;
    await c.query(`insert into tenant_settings (tenant_id) values ($1)`, [a]);
    await expectError(c,
      `update tenant_settings set default_billing_profile_id = $2 where tenant_id = $1`,
      [a, profileOfB], /23503|foreign key/);
  });
});

test("tenant slug and settings constraints", async () => {
  await withTx(async (c) => {
    await expectError(c, `insert into tenants (slug, name) values ('Bad Slug', 'X Clinic')`, [], /check/);
    await expectError(c, `insert into tenants (slug, name) values ('-bad', 'X Clinic')`, [], /check/);
    const t = await makeTenant(c);
    await expectError(c, `insert into tenant_settings (tenant_id, near_expiry_days, critical_expiry_days) values ($1, 30, 60)`, [t], /check/);
    const { rows } = await c.query(`insert into tenant_settings (tenant_id) values ($1) returning consultation_billing_point, allocation_policy`, [t]);
    assert.deepEqual(rows[0], { consultation_billing_point: "check_in", allocation_policy: "fefo" }); // D-58, D-40
  });
});
