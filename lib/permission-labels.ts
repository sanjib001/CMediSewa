import { PERMISSION_CATALOG, PERMISSION_KEYS, isClinical, type Permission } from "@/lib/permissions";

// Plain-language names for the role editor. Keys not listed are shown from their key.
const LABELS: Partial<Record<Permission, string>> = {
  view_queue: "See the OPD queue", manage_queue: "Run the OPD queue (check-in, call, tokens)",
  view_patients: "Look up patients", manage_patients: "Register and edit patients",
  view_appointments: "See appointments", manage_appointments: "Book and change appointments",
  view_schedules: "See doctor schedules", manage_schedules: "Change doctor schedules and leave", manage_own_leave: "Request own leave",
  record_vitals: "Record vitals", write_consultation: "Write consultations", issue_prescriptions: "Issue prescriptions",
  break_glass: "Emergency access to any patient's record", pharmacy_sell: "Sell at the pharmacy counter",
  dispense_prescription: "Dispense prescriptions", override_batch: "Choose a different batch than suggested",
  other_sales: "Other sales: bill typed-in items such as lab tests",
  all_stores: "Work in every store", manage_catalogue: "Departments, services and doctors", manage_website: "Edit the clinic website",
  manage_staff: "Staff, roles and devices", manage_settings: "Clinic settings", view_audit_log: "See the audit log",
  view_cost_prices: "See cost prices", allow_credit: "Allow sales on credit", void_invoices: "Void bills",
};
const SECTION_TITLES: Record<string, string> = {
  front_desk: "Front desk", schedules: "Schedules", clinical: "Clinical (verified professionals only)", pharmacy: "Pharmacy",
  inventory: "Stock", items: "Medicines and prices", purchasing: "Purchasing", billing: "Billing", finance: "Expenses and finance",
  reports: "Reports", website: "Website", administration: "Administration", lab: "Lab (Phase 3)",
};
export function permissionLabel(k: Permission): string {
  const l = LABELS[k] ?? k.replaceAll("_", " ");
  return l.charAt(0).toUpperCase() + l.slice(1);
}
export function permissionGroups(): { section: string; title: string; keys: { key: Permission; label: string; clinical: boolean }[] }[] {
  const out = new Map<string, { key: Permission; label: string; clinical: boolean }[]>();
  for (const k of PERMISSION_KEYS) {
    const sec = PERMISSION_CATALOG[k].section;
    if (!out.has(sec)) out.set(sec, []);
    out.get(sec)!.push({ key: k, label: permissionLabel(k), clinical: isClinical(k) });
  }
  return [...out].map(([section, keys]) => ({ section, title: SECTION_TITLES[section] ?? section, keys }));
}
