import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PERMISSION_CATALOG, PERMISSION_KEYS, ROLE_TEMPLATES, OPERATION_ASSURANCE, isClinical, meetsLevel, mfaRequired, pinProblem } from "./permissions.ts";
import { MODULE_KEYS } from "./modules.ts";

const sql = fs.readFileSync(new URL("../supabase/migrations/20261120100800_permission_catalog.sql", import.meta.url), "utf8");

test("generated SQL catalog matches lib/permissions.ts exactly (TS/SQL parity)", () => {
  const block = sql.split("insert into permission_catalog")[1]!.split(";")[0]!;
  const rows = [...block.matchAll(/\('([a-z_]+)', '([a-z_]+)', (null|'[a-z_]+'), (null|array\[[^\]]*\]::text\[\]), (true|false)\)/g)];
  assert.equal(rows.length, PERMISSION_KEYS.length, "same number of keys");
  for (const [, key, section, mod, profs, scoped] of rows) {
    const d = PERMISSION_CATALOG[key as keyof typeof PERMISSION_CATALOG] as { section: string; module?: string; requiresProfession?: readonly string[]; storeScoped?: boolean };
    assert.ok(d, `SQL key ${key} exists in TS`);
    assert.equal(section, d.section, `${key} section`);
    assert.equal(mod === "null" ? undefined : mod!.slice(1, -1), d.module, `${key} module`);
    const sqlProfs = profs === "null" ? undefined : [...profs!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(sqlProfs, d.requiresProfession ? [...d.requiresProfession] : undefined, `${key} professions`);
    assert.equal(scoped === "true", Boolean(d.storeScoped), `${key} store scope`);
  }
});

test("generated SQL role templates match TS", () => {
  const block = sql.split("insert into role_templates")[1]!.split(";")[0]!;
  const rows = [...block.matchAll(/\('([a-z_]+)', '[^']+', '([^']+)', (true|false), array\[([^\]]*)\]::text\[\]\)/g)];
  assert.equal(rows.length, ROLE_TEMPLATES.length);
  for (const [, key, home, seeded, perms] of rows) {
    const t = ROLE_TEMPLATES.find((x) => x.key === key)!;
    assert.equal(home, t.homeRoute);
    assert.equal(seeded === "true", t.seeded);
    assert.deepEqual([...perms!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...t.permissions]);
  }
});

test("catalog is internally consistent", () => {
  for (const [k, d] of Object.entries(PERMISSION_CATALOG)) {
    if ("module" in d && d.module) assert.ok((MODULE_KEYS as readonly string[]).includes(d.module), `${k} → unknown module ${d.module}`);
  }
  for (const t of ROLE_TEMPLATES) for (const p of t.permissions) assert.ok(p in PERMISSION_CATALOG, `${t.key} → ${p}`);
  // The four owner-requested dashboards exist as seeded templates (D-56).
  assert.deepEqual(ROLE_TEMPLATES.filter((t) => t.seeded).map((t) => t.homeRoute).sort(),
    ["/employee/lab", "/employee/opd", "/employee/pharmacy", "/employee/registrar"]);
  // The Pharmacy role combines counter, billing and stock work (D-57).
  const pharmacy = ROLE_TEMPLATES.find((t) => t.key === "pharmacy")!;
  for (const k of ["pharmacy_sell", "manage_billing", "manage_stock", "manage_purchases"]) assert.ok(pharmacy.permissions.includes(k as never), k);
});

test("clinical keys are exactly the credential-gated ones", () => {
  assert.ok(isClinical("write_consultation") && isClinical("dispense_prescription"));
  assert.ok(!isClinical("print_prescriptions") && !isClinical("manage_staff"));
});

test("assurance levels and the operation matrix", () => {
  assert.ok(meetsLevel("A3", "A2") && meetsLevel("A2", "A2") && !meetsLevel("A1", "A2"));
  assert.equal(OPERATION_ASSURANCE["clinical.chart"].level, "A2", "a PIN alone never opens a chart (D-27)");
  assert.equal(OPERATION_ASSURANCE["admin.area"].level, "A2");
  assert.equal(OPERATION_ASSURANCE["front_desk.operate"].level, "A1");
  assert.equal(OPERATION_ASSURANCE["devices.manage"].level, "A3");
});

test("P-11 and P-19 defaults", () => {
  assert.equal(mfaRequired({ membershipRole: "tenant_admin", professions: [] }), true);
  assert.equal(mfaRequired({ membershipRole: "tenant_member", professions: ["doctor"] }), true);
  assert.equal(mfaRequired({ membershipRole: "tenant_member", professions: ["pharmacist"] }), false);
  assert.equal(pinProblem("480715"), null);
  for (const bad of ["12345", "1234567", "abcdef", "111111", "123456", "987654", "456789"]) assert.notEqual(pinProblem(bad), null, bad);
});
