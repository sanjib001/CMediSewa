#!/usr/bin/env node
/**
 * DEVELOPMENT ONLY: create the demo clinic "arogya-demo" with one person per dashboard,
 * so the B1 sign-in flows can be used end to end.
 *
 *   node scripts/seed-dev.mjs            create if missing (re-running changes nothing)
 *   node scripts/seed-dev.mjs --reset    re-generate the demo passwords and PINs
 *
 * Generated passwords and PINs are written ONLY to scripts/dev-users.local.json (gitignored).
 * They are never printed. Refuses to run unless the target declares APP_ENV=development.
 *
 * Who:
 *   Admin     admin@arogya-demo.test   tenant_admin (2FA required at first sign-in, P-11)
 *   Registrar username "registrar"     Registrar role + PIN
 *   Doctor    username "doctor"        Doctor role + verified doctor credential (2FA required) + PIN
 *   Pharmacy  username "pharmacy"      Pharmacy role + verified pharmacist credential + PIN
 * Credentials are verified by the platform admin (single-admin clinic, P-30 default).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { ROOT, loadTarget, client } from "./lib/db.mjs";
import { pinProblem } from "../lib/permissions.ts";
import { ensureDemoSetup } from "./lib/demo-setup.mjs";

const SLUG = "arogya-demo";
const OUT = path.join(ROOT, "scripts", "dev-users.local.json");
const reset = process.argv.includes("--reset");

const target = loadTarget(".env.local");
if (target.appEnv !== "development") throw new Error("seed-dev runs on DEVELOPMENT targets only");
const admin = createClient(target.env.NEXT_PUBLIC_SUPABASE_URL, target.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const password = () => `${crypto.randomBytes(9).toString("base64url")}-Cm7`;
const pin = () => { for (;;) { const p = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"); if (!pinProblem(p)) return p; } };

const PEOPLE = [
  { key: "admin", name: "Asha Admin", title: "Clinic manager", role: null, admin: true, email: `admin@${SLUG}.test` },
  { key: "registrar", name: "Nirmala Shrestha", title: "Registrar", role: "registrar", username: "registrar" },
  { key: "doctor", name: "Dr. Anjali Shrestha", title: "General medicine", role: "doctor", username: "doctor", credential: { profession: "doctor", council: "Nepal Medical Council", reg: "DEMO-NMC-0001" } },
  { key: "pharmacy", name: "Kiran Bhandari", title: "Pharmacy", role: "pharmacy", username: "pharmacy", credential: { profession: "pharmacist", council: "Nepal Pharmacy Council", reg: "DEMO-NPC-0001" } },
];

const c = client(target);
// Auth users are created through the API, outside the DB transaction: remember them so a
// failed run deletes them again instead of leaving orphans behind.
const createdAuthIds = [];
await c.connect();
try {
  const { rows: [existing] } = await c.query(`select id from tenants where slug = $1`, [SLUG]);
  // B2: the demo clinic needs a plan and a covering subscription, or the expiry job
  // (suspend_expired_tenants) would suspend it. Ensured on every run, even without --reset.
  const ensureSubscription = async (tenantId) => {
    const { rows: [pl] } = await c.query(
      `insert into plans (code, name, description, price_npr, billing_cycle_days, features, is_public)
       values ('demo', 'Demo (development)', 'Development-only plan for the demo clinic', 0, 365, '{}', false)
       on conflict (code) do update set name = excluded.name returning id`);
    const { rows: [pu] } = await c.query(`select tenant_paid_until($1) d`, [tenantId]);
    if (!pu.d || new Date(pu.d) < new Date()) {
      const { rows: [pa0] } = await c.query(`select id from platform_admins where is_active order by created_at limit 1`);
      await c.query(`select add_subscription_period($1, $2, current_date, current_date + 364, 'complimentary', 0, 'dev seed', $3)`, [tenantId, pl.id, pa0?.id ?? null]);
      console.log("demo clinic: complimentary 1-year demo subscription added");
    }
  };
  if (existing && !reset) {
    await ensureSubscription(existing.id);
    console.log(`demo clinic "${SLUG}" already exists. Credentials are in ${path.relative(ROOT, OUT)} (use --reset to regenerate them).`);
    process.exit(0);
  }
  const { rows: [pa] } = await c.query(`select id from platform_admins where is_active order by created_at limit 1`);
  if (!pa) throw new Error("no platform admin exists: create one first (scripts/create-platform-admin.mjs)");

  const creds = { clinic: { slug: SLUG, signInLink: `/login/${SLUG}` }, people: {} };
  await c.query("begin");
  let tenantId = existing?.id;
  if (!tenantId) {
    ({ rows: [{ id: tenantId }] } = await c.query(
      `insert into tenants (slug, name, legal_name, business_type, status, phone, address_district, address_municipality)
       values ($1, 'Arogya Clinic & Pharmacy (demo)', 'Arogya Clinic Pvt. Ltd. (demo)', 'clinic_pharmacy', 'active', '01-5550123', 'Lalitpur', 'Lalitpur Metropolitan City')
       returning id`, [SLUG]));
    const { rows: [bp] } = await c.query(
      `insert into billing_profiles (tenant_id, name, legal_name, pan_vat_no, invoice_prefix, is_default)
       values ($1, 'Clinic', 'Arogya Clinic Pvt. Ltd. (demo)', '000000000', 'AR', true) returning id`, [tenantId]);
    await c.query(`insert into tenant_settings (tenant_id, default_billing_profile_id) values ($1, $2)`, [tenantId, bp.id]);
    await c.query(`select seed_role_templates($1)`, [tenantId]);
    await c.query(`insert into stores (tenant_id, code, name, kind, billing_profile_id, is_sellable, is_dispensing, is_receiving)
                   values ($1, 'PHARM', 'Pharmacy', 'pharmacy', $2, true, true, true), ($1, 'QUAR', 'Quarantine', 'quarantine', $2, false, false, false)`,
      [tenantId, bp.id]);
  }
  await ensureSubscription(tenantId);

  for (const p of PEOPLE) {
    const pw = password();
    const { rows: [m0] } = await c.query(`select id, auth_user_id from tenant_members where tenant_id = $1 and (lower(username) = $2 or lower(email) = $3)`,
      [tenantId, p.username ?? "", p.email ?? ""]);
    let memberId = m0?.id;
    let authId = m0?.auth_user_id;
    if (!memberId) {
      ({ rows: [{ id: memberId }] } = await c.query(
        `insert into tenant_members (tenant_id, membership_role, display_name, title, username, email)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [tenantId, p.admin ? "tenant_admin" : "tenant_member", p.name, p.title, p.username ?? null, p.email ?? null]));
    }
    // Username accounts sign in to Supabase Auth with an internal address (P-18).
    const authEmail = p.email ?? `m-${memberId}@users.cmedisewa.internal`;
    if (authId) {
      const { error } = await admin.auth.admin.updateUserById(authId, { password: pw });
      if (error) throw error;
    } else {
      const { data, error } = await admin.auth.admin.createUser({ email: authEmail, password: pw, email_confirm: true });
      if (error) throw error;
      authId = data.user.id;
      createdAuthIds.push(authId);
      await c.query(`update tenant_members set auth_user_id = $1 where id = $2`, [authId, memberId]);
    }
    if (p.role) {
      await c.query(`insert into member_roles (tenant_id, member_id, role_id)
                     select $1, $2, id from tenant_roles where tenant_id = $1 and template_key = $3 on conflict do nothing`, [tenantId, memberId, p.role]);
    }
    if (p.credential) {
      const { rows: [cr] } = await c.query(
        `insert into member_credentials (tenant_id, member_id, profession, council, registration_no) values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, profession, registration_no) do update set council = excluded.council returning id, verified_at`,
        [tenantId, memberId, p.credential.profession, p.credential.council, p.credential.reg]);
      if (!cr.verified_at) await c.query(`select verify_member_credential($1, null, $2)`, [cr.id, pa.id]);
    }
    let personPin = null;
    if (!p.admin) {
      personPin = pin();
      await c.query(`select set_member_pin($1, $2, $3)`, [tenantId, memberId, personPin]);
    }
    creds.people[p.key] = {
      name: p.name,
      login: p.email ?? p.username,
      password: pw,
      ...(personPin ? { pin: personPin } : {}),
      signIn: p.email ? "/login (or the clinic link)" : `/login/${SLUG} (username needs the clinic link)`,
      ...(p.admin || p.credential?.profession === "doctor" ? { note: "2FA: an authenticator app is required at first sign-in" } : {}),
    };
  }
  const setup = await ensureDemoSetup(c, tenantId);
  if (setup.length) console.log(`demo setup added: ${setup.join(", ")}`);
  await c.query(
    `insert into audit_log (tenant_id, actor_kind, action, target_type, target_id, outcome, detail)
     values ($1, 'system', 'dev.seed', 'tenant', $2, 'success', $3)`, [tenantId, String(tenantId), { via: "scripts/seed-dev.mjs", reset }]);
  await c.query("commit");
  fs.writeFileSync(OUT, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  console.log(`demo clinic "${SLUG}" ready with ${PEOPLE.length} people.`);
  console.log(`credentials written to ${path.relative(ROOT, OUT)} (gitignored, not printed).`);
  console.log("PIN sign-in needs a trusted device: sign in as the admin, then Admin → Trusted devices → Trust this device.");
} catch (e) {
  await c.query("rollback").catch(() => {});
  for (const id of createdAuthIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  if (createdAuthIds.length) console.error(`rolled back; removed ${createdAuthIds.length} auth user(s) created by this run`);
  throw e;
} finally {
  await c.end();
}
