// Navigation for the Admin and Employee areas.
//
// Phase 1 outline: static. From B1/U3 on, these lists are FILTERED by the member's
// effective permissions and modules (getAdminNav / getEmployeeNav, architecture.md §2),
// so the menu can never show something the guards would refuse. `module` and
// `permission` are recorded now so that filter has everything it needs.
import type { ModuleKey } from "./modules.ts";

export type NavItem = {
  href: string;
  label: string;
  icon: string; // lucide icon name, resolved in the shell
  module?: ModuleKey;
  permission?: string;
};

export type NavGroup = { label: string; items: NavItem[] };

export const ADMIN_NAV: NavGroup[] = [
  {
    label: "Today",
    items: [{ href: "/admin", label: "Dashboard", icon: "LayoutDashboard" }],
  },
  {
    label: "Clinic",
    items: [
      { href: "/admin/patients", label: "Patients", icon: "Users", permission: "view_patients" },
      { href: "/admin/appointments", label: "Appointments", icon: "CalendarDays", module: "appointments", permission: "view_appointments" },
      { href: "/admin/doctors", label: "Doctors & schedules", icon: "Stethoscope", module: "appointments" },
      { href: "/admin/services", label: "Departments & services", icon: "ClipboardList", module: "appointments" },
    ],
  },
  {
    label: "Pharmacy & stock",
    items: [
      { href: "/admin/medicines", label: "Medicines", icon: "Pill", module: "inventory", permission: "manage_items" },
      { href: "/admin/stock", label: "Stock", icon: "Boxes", module: "inventory", permission: "view_stock" },
      { href: "/admin/purchases", label: "Purchases", icon: "Package", module: "purchasing", permission: "manage_purchases" },
      { href: "/admin/vendors", label: "Vendors", icon: "Truck", module: "purchasing", permission: "manage_vendors" },
    ],
  },
  {
    label: "Money",
    items: [
      { href: "/admin/billing", label: "Billing", icon: "Receipt", permission: "view_billing" },
      { href: "/admin/expenses", label: "Expenses", icon: "Wallet", module: "expenses_finance", permission: "add_expenses" },
      { href: "/admin/finance", label: "Finance", icon: "CreditCard", module: "expenses_finance", permission: "view_finance" },
      { href: "/admin/reports", label: "Reports", icon: "BarChart3", permission: "view_reports" },
    ],
  },
  {
    label: "Setup",
    items: [
      { href: "/admin/website", label: "Clinic website", icon: "Globe", module: "website", permission: "manage_website" },
      { href: "/admin/staff", label: "Staff & roles", icon: "UserPlus", permission: "manage_staff" },
      { href: "/admin/devices", label: "Trusted devices", icon: "KeyRound", permission: "manage_staff" },
      { href: "/admin/settings", label: "Settings", icon: "Settings", permission: "manage_settings" },
      { href: "/admin/audit", label: "Audit log", icon: "ShieldCheck", permission: "view_audit_log" },
    ],
  },
];

export type Workspace = {
  key: "registrar" | "opd" | "pharmacy" | "lab";
  href: string;
  label: string;
  icon: string;
  module?: ModuleKey;
  /** Holding ANY of these keys shows the workspace (navigation = guards). */
  entry: string[];
  phase3?: boolean;
};

/** The staff dashboards (D-56). Lab arrives in Phase 3. */
export const WORKSPACES: Workspace[] = [
  { key: "registrar", href: "/employee/registrar", label: "Registrar", icon: "ClipboardList", module: "appointments", entry: ["manage_queue", "manage_patients", "manage_appointments"] },
  { key: "opd", href: "/employee/opd", label: "OPD", icon: "Stethoscope", module: "consultation", entry: ["write_consultation", "record_vitals"] },
  { key: "pharmacy", href: "/employee/pharmacy", label: "Pharmacy", icon: "Pill", module: "pharmacy_counter", entry: ["pharmacy_sell", "dispense_prescription", "view_stock"] },
  { key: "lab", href: "/employee/lab", label: "Lab", icon: "FlaskConical", module: "lab", entry: ["view_lab"], phase3: true },
];

export const SUPERADMIN_NAV: NavItem[] = [
  { href: "/superadmin", label: "Overview", icon: "Activity" },
  { href: "/superadmin/applications", label: "Applications", icon: "FileText" },
  { href: "/superadmin/tenants", label: "Clinics", icon: "Building2" },
  { href: "/superadmin/plans", label: "Plans & billing", icon: "CreditCard" },
  { href: "/superadmin/settings", label: "Platform settings", icon: "Settings" },
  { href: "/superadmin/audit", label: "Platform audit", icon: "ShieldCheck" },
];

/** Admin and Super Admin sections that exist in the menu but have no screen yet. */
export function findNavLabel(href: string): string | undefined {
  for (const g of ADMIN_NAV) for (const i of g.items) if (i.href === href) return i.label;
  return SUPERADMIN_NAV.find((i) => i.href === href)?.label;
}

/** The workspaces a member may open, given their effective permissions and modules. */
export function allowedWorkspaces(permissions: Iterable<string>, modules: Iterable<string>): Workspace[] {
  const p = new Set(permissions), m = new Set(modules);
  return WORKSPACES.filter((w) => !w.phase3 && (!w.module || m.has(w.module)) && w.entry.some((k) => p.has(k)));
}
