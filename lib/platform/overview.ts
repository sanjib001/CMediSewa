import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Platform overview data for the Super Admin dashboard. Counts and tenant metadata ONLY:
// nothing here may read a tenant's patients, stock or money (D-08).

export type TenantRow = {
  id: string; name: string; slug: string; status: "pending" | "active" | "suspended" | "closed";
  business_type: string; created_at: string;
};
export type PlatformEvent = { id: number; action: string; outcome: string; reason: string | null; created_at: string };

export async function getPlatformOverview() {
  const db = serviceClient();
  // Independent reads in parallel: latency is round trips, not query cost (HRestroSewa).
  const [tenants, admins, events, fiscal, apps] = await Promise.all([
    db.from("tenants").select("id, name, slug, status, business_type, created_at").order("created_at", { ascending: false }).limit(50),
    db.from("platform_admins").select("id", { count: "exact", head: true }).eq("is_active", true),
    // Platform-side events only: no tenant, or done BY a platform admin, or the expiry job.
    // Never a clinic's own activity (patient reads, sales…), D-08.
    db.from("audit_log").select("id, action, outcome, reason, created_at")
      .or("tenant_id.is.null,actor_kind.eq.platform_admin,action.eq.tenant.suspend")
      .order("id", { ascending: false }).limit(12),
    db.from("fiscal_years").select("code, ends_on").order("ends_on", { ascending: false }).limit(1),
    db.from("tenant_applications").select("id", { count: "exact", head: true }).eq("status", "submitted"),
  ]);
  for (const r of [tenants, admins, events, fiscal, apps]) {
    if (r.error) throw new Error(`platform overview query failed: ${r.error.code ?? ""} ${r.error.message}`);
  }
  const rows = (tenants.data ?? []) as TenantRow[];
  const byStatus = { pending: 0, active: 0, suspended: 0, closed: 0 };
  for (const t of rows) byStatus[t.status]++;
  return {
    tenants: rows,
    byStatus,
    activeAdmins: admins.count ?? 0,
    pendingApplications: apps.count ?? 0,
    events: (events.data ?? []) as PlatformEvent[],
    fiscalCoverage: (fiscal.data?.[0] as { code: string; ends_on: string } | undefined) ?? null,
  };
}

const EVENT_LABELS: Record<string, string> = {
  "auth.superadmin_password": "Password accepted",
  "auth.superadmin_mfa": "Signed in with authenticator code",
  "auth.superadmin_mfa_enrolled": "Authenticator set up and signed in",
  "auth.superadmin_signin": "Sign-in attempt",
  "auth.superadmin_signout": "Signed out",
  "platform_admin.grant": "Platform admin account granted",
  "application.submit": "New registration from the website",
  "application.reject": "Application rejected",
  "tenant.provision": "Clinic created from an application",
  "tenant.status": "Clinic status changed",
  "tenant.suspend": "Clinic suspended (subscription expired)",
  "subscription.add": "Subscription period added",
  "platform_invoice.issue": "Platform invoice issued",
  "platform_payment.record": "Payment recorded",
  "member.invite_reissue": "New invite link created",
};
export function describeEvent(e: PlatformEvent): string {
  const base = EVENT_LABELS[e.action] ?? e.action;
  if (e.outcome === "success") return base;
  const why: Record<string, string> = {
    bad_credentials: "wrong email or password",
    not_platform_admin: "account has no platform access",
    bad_code: "wrong authenticator code",
    rate_limited: "too many attempts",
  };
  return `${base} refused${e.reason ? `: ${why[e.reason] ?? e.reason}` : ""}`;
}

export function formatKathmandu(ts: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kathmandu", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(ts));
}
