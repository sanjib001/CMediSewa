import "server-only";
import type { TenantContext } from "./context";

const LEVEL_LABEL = { A1: "Signed in with PIN", A2: "Signed in with password", A3: "Signed in with password + code" } as const;

/** Keys that open the Admin area for someone who is not the tenant admin. */
export const ADMIN_AREA_KEYS = [
  "manage_staff", "manage_settings", "manage_catalogue", "view_audit_log", "manage_website",
  "view_finance", "view_financial_reports", "manage_expenses", "manage_items", "manage_purchases",
  "manage_vendors", "view_reports",
] as const;

export function canEnterAdmin(ctx: TenantContext): boolean {
  return ctx.membershipRole === "tenant_admin" || ADMIN_AREA_KEYS.some((k) => ctx.permissions.has(k));
}

export function tenantBarProps(ctx: TenantContext, area: "admin" | "employee") {
  return {
    area,
    tenantName: ctx.tenantName,
    displayName: ctx.displayName,
    levelLabel: LEVEL_LABEL[ctx.level],
    showAdminSwitch: area === "admin" || canEnterAdmin(ctx),
  };
}
