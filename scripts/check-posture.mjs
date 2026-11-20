#!/usr/bin/env node
// Verifies the database access posture (security.md §4, §11, §12). Exit 1 on any violation.
//   node scripts/check-posture.mjs [--env <file>]
import { loadTarget, client, parseArgs } from "./lib/db.mjs";
import { checkPosture } from "./lib/posture.mjs";

const { envFile } = parseArgs();
const target = loadTarget(envFile);
const c = client(target);
await c.connect();
try {
  const violations = await checkPosture(c);
  console.log(`posture check on ${target.appEnv.toUpperCase()} (${target.host})`);
  if (violations.length) {
    for (const x of violations) console.log(`  ✗ ${x}`);
    process.exitCode = 1;
  } else {
    console.log("  ✓ all rules hold");
  }
} finally {
  await c.end();
}
