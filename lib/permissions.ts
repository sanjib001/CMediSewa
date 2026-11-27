// The single source of truth for permissions (permissions.md; HRestroSewa's lib/permissions.ts
// pattern). The SQL catalog tables are GENERATED from this file
// (scripts/gen-permission-catalog.mjs), and a test asserts that TS and SQL agree.
//
// A key is effective for a member only if ALL hold (permissions.md §4/§11):
//   * granted: tenant_admin holds every NON-clinical key implicitly; others through roles ∪
//     grants − revokes;
//   * its module is effective for the tenant (lib/modules.ts);
//   * if it is clinical (requiresProfession), the member holds a VERIFIED credential of one of
//     those professions. A tenant_admin never gets clinical keys implicitly (D-06).
// Assurance (A1/A2/A3) is a separate axis: see OPERATION_ASSURANCE below.
import type { ModuleKey } from "./modules.ts";

export type Profession = "doctor" | "nurse" | "pharmacist" | "lab_technician";
export const PROFESSIONS: readonly Profession[] = ["doctor", "nurse", "pharmacist", "lab_technician"];

type KeyDef = {
  section: string;
  module?: ModuleKey;
  requiresProfession?: readonly Profession[];
  storeScoped?: boolean;
};

export const PERMISSION_CATALOG = {
  // Front desk
  view_patients:        { section: "front_desk" },
  manage_patients:      { section: "front_desk" },
  view_appointments:    { section: "front_desk", module: "appointments" },
  manage_appointments:  { section: "front_desk", module: "appointments" },
  view_queue:           { section: "front_desk", module: "appointments" },
  manage_queue:         { section: "front_desk", module: "appointments" },
  // Schedules
  view_schedules:       { section: "schedules", module: "appointments" },
  manage_schedules:     { section: "schedules", module: "appointments" },
  manage_own_leave:     { section: "schedules", module: "appointments" },
  // Clinical (credential-gated)
  record_vitals:        { section: "clinical", module: "consultation", requiresProfession: ["doctor", "nurse"] },
  view_clinical:        { section: "clinical", module: "consultation", requiresProfession: ["doctor", "nurse", "lab_technician"] },
  write_consultation:   { section: "clinical", module: "consultation", requiresProfession: ["doctor"] },
  issue_prescriptions:  { section: "clinical", module: "consultation", requiresProfession: ["doctor"] },
  view_all_clinical:    { section: "clinical", module: "consultation", requiresProfession: ["doctor"] },
  break_glass:          { section: "clinical", module: "consultation", requiresProfession: ["doctor", "nurse"] },
  print_prescriptions:  { section: "clinical", module: "consultation" },
  // Pharmacy counter
  pharmacy_sell:          { section: "pharmacy", module: "pharmacy_counter", storeScoped: true },
  dispense_prescription:  { section: "pharmacy", module: "pharmacy_counter", requiresProfession: ["pharmacist"], storeScoped: true },
  sell_prescription_only: { section: "pharmacy", module: "pharmacy_counter", requiresProfession: ["pharmacist"], storeScoped: true },
  override_batch:         { section: "pharmacy", module: "pharmacy_counter", storeScoped: true },
  other_sales:            { section: "pharmacy", module: "pharmacy_counter", storeScoped: true },
  // Inventory (store-scoped)
  view_stock:           { section: "inventory", module: "inventory", storeScoped: true },
  receive_stock:        { section: "inventory", module: "inventory", storeScoped: true },
  transfer_stock:       { section: "inventory", module: "inventory", storeScoped: true },
  approve_transfers:    { section: "inventory", module: "inventory", storeScoped: true },
  manage_stock:         { section: "inventory", module: "inventory", storeScoped: true },
  dispose_stock:        { section: "inventory", module: "inventory", storeScoped: true },
  block_batches:        { section: "inventory", module: "inventory" },
  all_stores:           { section: "inventory", module: "inventory" },
  // Item master
  manage_items:         { section: "items", module: "inventory" },
  set_prices:           { section: "items", module: "inventory" },
  // Purchasing
  manage_purchases:     { section: "purchasing", module: "purchasing", storeScoped: true },
  return_to_vendor:     { section: "purchasing", module: "purchasing" },
  manage_vendors:       { section: "purchasing", module: "purchasing" },
  pay_vendors:          { section: "purchasing", module: "purchasing" },
  // Billing
  view_billing:         { section: "billing" },
  manage_billing:       { section: "billing" },
  apply_discounts:      { section: "billing" },
  void_invoices:        { section: "billing" },
  sale_returns:         { section: "billing" },
  issue_refunds:        { section: "billing" },
  allow_credit:         { section: "billing" },
  // Expenses & finance
  add_expenses:         { section: "finance", module: "expenses_finance" },
  manage_expenses:      { section: "finance", module: "expenses_finance" },
  view_finance:         { section: "finance", module: "expenses_finance" },
  view_cost_prices:     { section: "finance", module: "inventory" },
  // Reports
  view_reports:         { section: "reports" },
  view_financial_reports: { section: "reports", module: "expenses_finance" },
  view_stock_reports:   { section: "reports", module: "inventory", storeScoped: true },
  // Website
  manage_website:       { section: "website", module: "website" },
  // Administration
  manage_staff:         { section: "administration" },
  manage_settings:      { section: "administration" },
  manage_catalogue:     { section: "administration" },
  view_audit_log:       { section: "administration" },
  // Lab (Phase 3)
  view_lab:             { section: "lab", module: "lab" },
  manage_lab_orders:    { section: "lab", module: "lab" },
  enter_lab_results:    { section: "lab", module: "lab", requiresProfession: ["lab_technician", "doctor"] },
} as const satisfies Record<string, KeyDef>;

export type Permission = keyof typeof PERMISSION_CATALOG;
export const PERMISSION_KEYS = Object.keys(PERMISSION_CATALOG) as Permission[];

export function isClinical(key: Permission): boolean {
  return "requiresProfession" in PERMISSION_CATALOG[key];
}

// ── Role templates seeded into every tenant (permissions.md §9, D-56, D-57) ──────────
export type RoleTemplate = {
  key: string;
  name: string;
  homeRoute: string;
  seeded: boolean; // seeded at provisioning (true) or offered when adding staff (false)
  permissions: readonly Permission[];
};

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: "registrar", name: "Registrar", homeRoute: "/employee/registrar", seeded: true,
    permissions: ["view_patients", "manage_patients", "view_appointments", "manage_appointments", "view_schedules",
      "view_queue", "manage_queue", "view_billing", "manage_billing", "print_prescriptions"],
  },
  {
    key: "doctor", name: "Doctor", homeRoute: "/employee/opd", seeded: true,
    permissions: ["view_patients", "view_schedules", "manage_own_leave", "view_queue", "record_vitals", "view_clinical",
      "write_consultation", "issue_prescriptions", "print_prescriptions"],
  },
  {
    key: "pharmacy", name: "Pharmacy", homeRoute: "/employee/pharmacy", seeded: true,
    permissions: ["pharmacy_sell", "dispense_prescription", "sell_prescription_only", "override_batch", "view_billing",
      "manage_billing", "sale_returns", "view_stock", "receive_stock", "transfer_stock", "approve_transfers",
      "manage_stock", "dispose_stock", "block_batches", "manage_items", "set_prices", "manage_purchases",
      "return_to_vendor", "manage_vendors", "pay_vendors", "view_cost_prices", "view_stock_reports"],
  },
  {
    key: "lab_technician", name: "Lab technician", homeRoute: "/employee/lab", seeded: true,
    permissions: ["view_patients", "view_queue", "view_lab", "enter_lab_results"],
  },
  {
    key: "nurse", name: "Nurse / health assistant", homeRoute: "/employee/registrar", seeded: false,
    permissions: ["view_patients", "view_queue", "manage_queue", "record_vitals", "view_clinical"],
  },
  {
    key: "cashier", name: "Cashier", homeRoute: "/employee/pharmacy", seeded: false,
    permissions: ["view_billing", "manage_billing", "pharmacy_sell"],
  },
  {
    key: "accountant", name: "Accountant", homeRoute: "/admin", seeded: false,
    permissions: ["view_billing", "add_expenses", "manage_expenses", "view_finance", "view_financial_reports",
      "view_cost_prices", "pay_vendors", "all_stores"],
  },
];

// ── Session assurance (permissions.md §2–§3) ──────────────────────────────────────
export type AssuranceLevel = "A1" | "A2" | "A3";
const LEVEL_RANK: Record<AssuranceLevel, number> = { A1: 1, A2: 2, A3: 3 };
export function meetsLevel(have: AssuranceLevel, need: AssuranceLevel): boolean {
  return LEVEL_RANK[have] >= LEVEL_RANK[need];
}

/** Minimum level (and whether a re-auth within RECENT_REAUTH_MS is required) per operation. */
export const OPERATION_ASSURANCE = {
  "employee.area":          { level: "A1" },
  "front_desk.operate":     { level: "A1" },
  "pharmacy.counter":       { level: "A1" },
  "stock.operate":          { level: "A1" },
  "clinical.chart":         { level: "A2" },
  "clinical.write":         { level: "A2" },
  "admin.area":             { level: "A2" },
  "stock.post":             { level: "A2" },
  "money.correct":          { level: "A2", recentReauth: true },
  "settings.change":        { level: "A2", recentReauth: true },
  "staff.manage":           { level: "A3", recentReauth: true },
  "devices.manage":         { level: "A3", recentReauth: true },
  "export":                 { level: "A3" },
  "break_glass":            { level: "A2", recentReauth: true },
} as const satisfies Record<string, { level: AssuranceLevel; recentReauth?: boolean }>;
export type Operation = keyof typeof OPERATION_ASSURANCE;

export const RECENT_REAUTH_MS = 5 * 60 * 1000;

/** P-11 default: 2FA is mandatory for clinic admins and doctors (and always for platform admins). */
export function mfaRequired(m: { membershipRole: string; professions: readonly string[] }): boolean {
  return m.membershipRole === "tenant_admin" || m.professions.includes("doctor");
}

/** P-19 default: 6 digits, refusing the obvious ones. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) return "A PIN is exactly 6 digits.";
  if (/^(\d)\1{5}$/.test(pin)) return "Choose a PIN that isn't one digit repeated.";
  if ("0123456789012".includes(pin) || "9876543210987".includes(pin)) return "Choose a PIN that isn't a sequence.";
  return null;
}
