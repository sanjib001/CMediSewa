// Module registry: the single source for which modules exist and when they are on
// (architecture.md §2b, D-50). The way lib/permissions.ts is the single source for
// permissions.
//
// effective(module) = business type allows it
//                   ∧ the plan includes it (when it needs a plan feature)
//                   ∧ the tenant has not switched it off (tenant_modules)
//                   ∧ every module it requires is effective.
// A module that is not effective is not navigable, not grantable and not postable
// (MODULE_DISABLED). Switching a module off never deletes data.
//
// MODULE_KEYS must equal the CHECK list on tenant_modules.module_key (migration 0003);
// a unit test enforces it.

export type BusinessType = "clinic" | "clinic_pharmacy" | "pharmacy";

export const MODULE_KEYS = [
  "appointments",
  "consultation",
  "inventory",
  "purchasing",
  "pharmacy_counter",
  "lab",
  "expenses_finance",
  "website",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

type ModuleDef = {
  key: ModuleKey;
  label: string;
  businessTypes: readonly BusinessType[];
  planFeature?: string;
  requires: readonly ModuleKey[];
  /** On unless the tenant switches it off, per business type. */
  defaultOn: (bt: BusinessType) => boolean;
};

const ALL: readonly BusinessType[] = ["clinic", "clinic_pharmacy", "pharmacy"];
const WITH_CLINIC: readonly BusinessType[] = ["clinic", "clinic_pharmacy"];
const WITH_PHARMACY: readonly BusinessType[] = ["clinic_pharmacy", "pharmacy"];

export const MODULES: Readonly<Record<ModuleKey, ModuleDef>> = {
  appointments:     { key: "appointments",     label: "Appointments & public booking", businessTypes: WITH_CLINIC,   requires: [],                         defaultOn: () => true },
  consultation:     { key: "consultation",     label: "OPD consultation & prescriptions", businessTypes: WITH_CLINIC, requires: ["appointments"],         defaultOn: () => true },
  inventory:        { key: "inventory",        label: "Medicine inventory & stores",   businessTypes: ALL,           requires: [],                         defaultOn: (bt) => bt !== "clinic" },
  purchasing:       { key: "purchasing",       label: "Vendors & purchases",           businessTypes: ALL,           requires: ["inventory"],              defaultOn: (bt) => bt !== "clinic" },
  pharmacy_counter: { key: "pharmacy_counter", label: "Pharmacy dispensing & sales",   businessTypes: WITH_PHARMACY, requires: ["inventory"],              defaultOn: () => true },
  lab:              { key: "lab",              label: "Laboratory (Phase 3)",          businessTypes: WITH_CLINIC,   planFeature: "lab", requires: ["consultation"], defaultOn: () => false },
  expenses_finance: { key: "expenses_finance", label: "Expenses & finance",            businessTypes: ALL,           requires: [],                         defaultOn: () => true },
  website:          { key: "website",          label: "Public website",                businessTypes: ALL,           requires: [],                         defaultOn: () => true },
};

export type ModuleInputs = {
  businessType: BusinessType;
  /** plans.features of the tenant's current plan. */
  planFeatures: readonly string[];
  /** Explicit tenant_modules rows; a missing key means "use the default". */
  toggles: Partial<Record<ModuleKey, boolean>>;
};

/** The set of effective modules for a tenant. Dependencies are resolved to a fixed point. */
export function effectiveModules(input: ModuleInputs): Set<ModuleKey> {
  const candidate = new Set<ModuleKey>();
  for (const key of MODULE_KEYS) {
    const m = MODULES[key];
    if (!m.businessTypes.includes(input.businessType)) continue;
    if (m.planFeature && !input.planFeatures.includes(m.planFeature)) continue;
    const on = input.toggles[key] ?? m.defaultOn(input.businessType);
    if (on) candidate.add(key);
  }
  // Drop anything whose requirements are not effective, until nothing changes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of candidate) {
      if (MODULES[key].requires.some((r) => !candidate.has(r))) {
        candidate.delete(key);
        changed = true;
      }
    }
  }
  return candidate;
}

/** Why a module is not effective, for the Admin → Modules screen (or null if it is). */
export function whyDisabled(key: ModuleKey, input: ModuleInputs): string | null {
  const m = MODULES[key];
  if (!m.businessTypes.includes(input.businessType)) return `not available for ${input.businessType}`;
  if (m.planFeature && !input.planFeatures.includes(m.planFeature)) return `needs a plan with "${m.planFeature}"`;
  if (!(input.toggles[key] ?? m.defaultOn(input.businessType))) return "switched off";
  const eff = effectiveModules(input);
  const missing = m.requires.filter((r) => !eff.has(r));
  if (missing.length) return `needs ${missing.map((r) => MODULES[r].label).join(", ")}`;
  return null;
}
