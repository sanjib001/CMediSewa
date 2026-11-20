// DB test helpers. Every test runs inside ONE transaction that is always rolled back, so
// tests can run against the shared dev database without leaving rows behind.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadTarget, client } from "../../scripts/lib/db.mjs";

const target = loadTarget(process.env.CMEDISEWA_TEST_ENV ?? ".env.local");
if (target.appEnv === "production") throw new Error("DB tests refuse to run against production");

export async function withTx(fn) {
  const c = client(target);
  await c.connect();
  try {
    await c.query("begin");
    await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    await c.end();
  }
}

/** Run `sql` in a savepoint and assert it fails with a message matching `pattern`. */
export async function expectError(c, sql, params, pattern) {
  const sp = `sp_${randomUUID().replaceAll("-", "")}`;
  await c.query(`savepoint ${sp}`);
  try {
    await c.query(sql, params);
    assert.fail(`expected failure matching ${pattern}, but the statement succeeded:\n${sql}`);
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    assert.match(`${e.code ?? ""} ${e.message}`, pattern);
  } finally {
    await c.query(`rollback to savepoint ${sp}`);
  }
}

/** Insert a tenant (as the migrating role) and return its id. */
export async function makeTenant(c, overrides = {}) {
  const slug = overrides.slug ?? `t-${randomUUID().slice(0, 8)}`;
  const { rows } = await c.query(
    `insert into tenants (slug, name) values ($1, $2) returning id`,
    [slug, overrides.name ?? `Test Clinic ${slug}`]
  );
  return rows[0].id;
}

export const uuid = randomUUID;
