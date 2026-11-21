import "server-only";
import type { TenantContext } from "./context";
import { serviceClient } from "@/lib/supabase/service";

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

export async function tenantBarProps(ctx: TenantContext, area: "admin" | "employee") {
  const { count } = await serviceClient().from("notifications").select("id", { count: "exact", head: true })
    .eq("tenant_id", ctx.tenantId).eq("member_id", ctx.memberId).is("read_at", null);
  return {
    unread: count ?? 0,
    // Idle lock: the clinic's setting on a trusted (PIN) device, at least 15 minutes elsewhere.
    idleLockMinutes: ctx.deviceId ? ctx.idleLockMinutes : Math.max(15, ctx.idleLockMinutes),
    // The top-bar patient search: Admin → Patients for those who can open Admin, else the desk.
    searchHref: !ctx.permissions.has("view_patients") ? null : canEnterAdmin(ctx) ? "/admin/patients" : ctx.permissions.has("view_queue") ? "/employee/registrar" : null,
    area,
    tenantName: ctx.tenantName,
    displayName: ctx.displayName,
    levelLabel: LEVEL_LABEL[ctx.level],
    showAdminSwitch: area === "admin" || canEnterAdmin(ctx),
  };
}
