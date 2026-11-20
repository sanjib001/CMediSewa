import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MODULE_KEYS, effectiveModules, whyDisabled } from "./modules.ts";

test("MODULE_KEYS equals the tenant_modules CHECK list in SQL", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/20261120100200_tenancy_core.sql", import.meta.url), "utf8");
  const m = sql.match(/module_key\s+text not null check \(module_key in\s*\(([^)]*)\)/);
  assert.ok(m?.[1], "CHECK list not found");
  const sqlKeys = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(sqlKeys, [...MODULE_KEYS].sort());
});

test("launch tenant (clinic_pharmacy) gets every MVP module, lab stays off", () => {
  const eff = effectiveModules({ businessType: "clinic_pharmacy", planFeatures: [], toggles: {} });
  assert.deepEqual([...eff].sort(), ["appointments", "consultation", "expenses_finance", "inventory", "pharmacy_counter", "purchasing", "website"]);
  assert.equal(whyDisabled("lab", { businessType: "clinic_pharmacy", planFeatures: [], toggles: {} }), 'needs a plan with "lab"');
});

test("switching off a dependency switches off its dependents", () => {
  const input = { businessType: "clinic_pharmacy" as const, planFeatures: [], toggles: { inventory: false } };
  const eff = effectiveModules(input);
  assert.ok(!eff.has("inventory") && !eff.has("purchasing") && !eff.has("pharmacy_counter"));
  assert.ok(eff.has("consultation"), "clinic modules are unaffected");
  assert.match(whyDisabled("pharmacy_counter", input) ?? "", /needs Medicine inventory/);
});

test("business type gates modules", () => {
  const pharmacyOnly = effectiveModules({ businessType: "pharmacy", planFeatures: ["lab"], toggles: {} });
  assert.ok(!pharmacyOnly.has("appointments") && !pharmacyOnly.has("lab"));
  assert.ok(pharmacyOnly.has("pharmacy_counter"));
  const clinicOnly = effectiveModules({ businessType: "clinic", planFeatures: [], toggles: {} });
  assert.ok(!clinicOnly.has("pharmacy_counter") && !clinicOnly.has("inventory"));
});

test("lab needs the plan feature, the toggle and consultation", () => {
  const on = { businessType: "clinic_pharmacy" as const, planFeatures: ["lab"], toggles: { lab: true } };
  assert.ok(effectiveModules(on).has("lab"));
  assert.ok(!effectiveModules({ ...on, toggles: { lab: true, appointments: false } }).has("lab"));
});
