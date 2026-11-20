#!/usr/bin/env node
/**
 * DEVELOPMENT ONLY: add the B3 setup data (services, the doctor's OPD hours, a published
 * website) to the existing demo clinic WITHOUT touching anyone's password or PIN.
 * seed-dev.mjs runs the same step for a fresh demo clinic.
 *
 *   node scripts/seed-dev-setup.mjs
 */
import { loadTarget, client } from "./lib/db.mjs";
import { ensureDemoSetup } from "./lib/demo-setup.mjs";

const target = loadTarget(".env.local");
if (target.appEnv !== "development") throw new Error("seed-dev-setup runs on DEVELOPMENT targets only");
const c = client(target);
await c.connect();
try {
  const { rows: [t] } = await c.query(`select id from tenants where slug = 'arogya-demo'`);
  if (!t) throw new Error("demo clinic not found: run node scripts/seed-dev.mjs first");
  await c.query("begin");
  const done = await ensureDemoSetup(c, t.id);
  await c.query("commit");
  console.log(done.length ? `added: ${done.join(", ")}` : "demo setup already complete; nothing changed");
} catch (e) {
  await c.query("rollback").catch(() => {});
  throw e;
} finally {
  await c.end();
}
