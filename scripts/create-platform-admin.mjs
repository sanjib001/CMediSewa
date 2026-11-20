#!/usr/bin/env node
/**
 * Create (or attach) a Super Admin on a target database.
 *
 *   CM_ADMIN_PASSWORD='…' node scripts/create-platform-admin.mjs <email> "<display name>" [--env <file>] [--reset-password] [--yes]
 *
 * The password comes ONLY from the CM_ADMIN_PASSWORD environment variable. It is never
 * written to disk, never printed, and never accepted as an argument.
 * - If the auth user does not exist, it is created (email confirmed).
 * - If it exists, its password is left unchanged unless --reset-password is given.
 * - The platform_admins row and an audit_log entry are written in one transaction.
 * Production/staging targets follow the same interlocks as the migration runner.
 */
import { createClient } from "@supabase/supabase-js";
import { loadTarget, assertWritable, client, parseArgs } from "./lib/db.mjs";

const argv = process.argv.slice(2);
const { envFile, prod, yes } = parseArgs(argv);
const positional = argv.filter((a, i) => !a.startsWith("-") && !(argv[i - 1] === "--env"));
const [email, displayName = "Platform Admin"] = positional;
const resetPassword = argv.includes("--reset-password");
const password = process.env.CM_ADMIN_PASSWORD;

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("usage: create-platform-admin.mjs <email> \"<display name>\"");
if (!password) throw new Error("set CM_ADMIN_PASSWORD in the environment (never pass it as an argument)");
if (password.length < 10) throw new Error("password must be at least 10 characters (security.md §2)");

const target = loadTarget(envFile);
assertWritable(target, { prod, yes });
const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SECRET_KEY: secret } = target.env;
if (!url || !secret) throw new Error(`${target.file}: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required`);

const supabase = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });

async function findUserByEmail(addr) {
  for (let page = 1; page < 100; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === addr.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

let user = await findUserByEmail(email);
let action;
if (!user) {
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`auth createUser failed: ${error.message}`);
  user = data.user;
  action = "created auth user";
} else if (resetPassword) {
  const { error } = await supabase.auth.admin.updateUserById(user.id, { password });
  if (error) throw new Error(`auth password reset failed: ${error.message}`);
  action = "existing auth user, password reset";
} else {
  action = "existing auth user, password unchanged";
}

const c = client(target);
await c.connect();
try {
  await c.query("begin");
  const { rows } = await c.query(
    `insert into platform_admins (auth_user_id, display_name) values ($1, $2)
     on conflict (auth_user_id) do update set is_active = true, display_name = excluded.display_name
     returning id, (xmax = 0) as inserted`,
    [user.id, displayName]
  );
  await c.query(
    `insert into audit_log (tenant_id, actor_kind, action, target_type, target_id, outcome, detail)
     values (null, 'system', 'platform_admin.grant', 'platform_admin', $1, 'success', $2)`,
    [rows[0].id, { via: "scripts/create-platform-admin.mjs", email_domain: email.split("@")[1], auth_action: action }]
  );
  await c.query("commit");
  console.log(`target: ${target.appEnv.toUpperCase()} (${target.host})`);
  console.log(`  ${action}`);
  console.log(`  platform admin ${rows[0].inserted ? "created" : "already present (re-activated)"}: ${displayName} <${email}>`);
  console.log("  TOTP enrolment is required at first sign-in once B1 is built (L1).");
} catch (e) {
  await c.query("rollback").catch(() => {});
  throw e;
} finally {
  await c.end();
}
