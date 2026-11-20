import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { serviceClient } from "@/lib/supabase/service";
import { getAuthIdentity, type AuthIdentity } from "./current-user";
import { LAST_TENANT_COOKIE } from "./hmac";
import {
  OPERATION_ASSURANCE, RECENT_REAUTH_MS, meetsLevel, mfaRequired,
  type AssuranceLevel, type Operation, type Permission,
} from "@/lib/permissions";
import type { ModuleKey } from "@/lib/modules";

export type TenantContext = {
  identity: AuthIdentity;
  memberId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantStatus: "pending" | "active" | "suspended" | "closed";
  businessType: string;
  membershipRole: "tenant_admin" | "tenant_member";
  displayName: string;
  roles: { name: string; home_route: string; template_key: string | null }[];
  professions: string[];
  permissions: Set<string>;
  modules: Set<string>;
  level: AssuranceLevel;
  method: "pin" | "password" | "mfa" | null;
  deviceId: string | null;
  passwordAuthAt: Date | null;
  reauthAt: Date | null;
  mfaRequired: boolean;
  shiftWindowHours: number;
  idleLockMinutes: number;
  pinPolicy: "off" | "allowed" | "required";
};

type RawContext = {
  member_id: string; tenant_id: string; tenant_slug: string; tenant_name: string;
  tenant_status: TenantContext["tenantStatus"]; business_type: string;
  membership_role: TenantContext["membershipRole"]; display_name: string;
  roles: TenantContext["roles"]; professions: string[]; permissions: string[]; modules: string[];
  assurance: null | { level: AssuranceLevel; method: "pin" | "password" | "mfa"; device_id: string | null;
    password_auth_at: string | null; reauth_at: string | null; tenant_id: string | null };
  pin_policy: TenantContext["pinPolicy"] | null; shift_window_hours: number | null; idle_lock_minutes: number | null;
};

/**
 * The tenant context of this request: ONE database round trip (resolve_request_context),
 * memoised per request. Live on every request: membership, tenant status, permissions,
 * modules and the session's assurance level. Returns null when the person is not an active
 * member of any open tenant.
 */
export const getTenantContext = cache(async (): Promise<TenantContext | null> => {
  const identity = await getAuthIdentity();
  if (!identity) return null;
  const { data, error } = await serviceClient().rpc("resolve_request_context", {
    p_auth_user: identity.id, p_session: identity.sessionId, p_tenant: null,
  });
  if (error) throw new Error(`resolve_request_context failed: ${error.code ?? ""} ${error.message}`);
  if (!data) return null;
  const r = data as RawContext;
  const a = r.assurance && r.assurance.tenant_id === r.tenant_id ? r.assurance : null;
  // The JWT's aal2 (a verified authenticator code) is authoritative for A3. A session with no
  // assurance record (created outside our sign-in flows) is treated as the weakest level.
  const level: AssuranceLevel = identity.aal === "aal2" ? "A3" : a?.level === "A3" ? "A2" : a?.level ?? "A1";
  return {
    identity,
    memberId: r.member_id, tenantId: r.tenant_id, tenantSlug: r.tenant_slug, tenantName: r.tenant_name,
    tenantStatus: r.tenant_status, businessType: r.business_type, membershipRole: r.membership_role,
    displayName: r.display_name, roles: r.roles, professions: r.professions,
    permissions: new Set(r.permissions), modules: new Set(r.modules),
    level, method: a?.method ?? null, deviceId: a?.device_id ?? null,
    passwordAuthAt: a?.password_auth_at ? new Date(a.password_auth_at) : null,
    reauthAt: a?.reauth_at ? new Date(a.reauth_at) : null,
    mfaRequired: mfaRequired({ membershipRole: r.membership_role, professions: r.professions }),
    shiftWindowHours: r.shift_window_hours ?? 12, idleLockMinutes: r.idle_lock_minutes ?? 10,
    pinPolicy: r.pin_policy ?? "allowed",
  };
});

export function can(ctx: TenantContext, key: Permission): boolean {
  return ctx.permissions.has(key);
}
export function hasModule(ctx: TenantContext, key: ModuleKey): boolean {
  return ctx.modules.has(key);
}

/** Where a signed-out staff member belongs: their own clinic's sign-in link if we know it. */
export async function staffLoginPath(): Promise<string> {
  const slug = (await cookies()).get(LAST_TENANT_COOKIE)?.value;
  return slug ? `/login/${encodeURIComponent(slug)}` : "/login";
}

/** Home for a member after sign-in: admins → Admin, others → their first role's home. */
export function homeFor(ctx: Pick<TenantContext, "membershipRole" | "roles" | "level">): string {
  if (ctx.membershipRole === "tenant_admin" && meetsLevel(ctx.level, "A2")) return "/admin";
  return ctx.roles[0]?.home_route ?? "/employee/registrar";
}

/**
 * The guard for every tenant page and action (permissions.md §1–§3):
 * signed in → active member → tenant open for this area → MFA done where required →
 * assurance level for the operation (step-up otherwise) → optional permission.
 */
export async function requireTenant(opts: {
  operation: Operation;
  permission?: Permission;
  allowPendingTenant?: boolean;
  next?: string;
}): Promise<TenantContext> {
  const ctx = await getTenantContext();
  if (!ctx) {
    const identity = await getAuthIdentity();
    redirect(identity ? "/login?no_access=1" : await staffLoginPath());
  }
  if (ctx.tenantStatus === "suspended" && opts.operation !== "admin.area") redirect("/login?suspended=1");
  if (ctx.tenantStatus === "pending" && !opts.allowPendingTenant) redirect("/admin");

  const need = OPERATION_ASSURANCE[opts.operation];
  // A password session of someone who must use 2FA is finished at the MFA step first.
  if (ctx.mfaRequired && ctx.method !== "pin" && ctx.identity.aal !== "aal2") redirect("/login/mfa");
  if (!meetsLevel(ctx.level, need.level)) {
    redirect(`/login/verify?next=${encodeURIComponent(opts.next ?? "/employee")}`);
  }
  if ("recentReauth" in need && need.recentReauth) {
    const fresh = ctx.reauthAt && Date.now() - ctx.reauthAt.getTime() < RECENT_REAUTH_MS;
    if (!fresh) redirect(`/login/verify?next=${encodeURIComponent(opts.next ?? "/admin")}`);
  }
  if (opts.permission && !can(ctx, opts.permission)) redirect("/employee?denied=1");
  return ctx;
}
