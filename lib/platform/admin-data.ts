import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Read models for the Super Admin screens (B2/U2). Platform metadata only (D-08).

export type Plan = {
  id: string; code: string; name: string; description: string | null; price_npr: number; billing_cycle_days: number;
  max_doctors: number | null; max_members: number | null; features: string[]; is_public: boolean; is_active: boolean;
};
export type Application = {
  id: string; business_name: string; owner_name: string; email: string; phone: string; district: string | null;
  municipality: string | null; pan_number: string | null; message: string | null; status: string; created_at: string;
  reject_reason: string | null; tenant_id: string | null; plan_interest: string | null;
};

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? ([] as unknown)) as T;
}

export async function listPlans(): Promise<Plan[]> {
  return must(await serviceClient().from("plans").select("*").order("sort_order").order("price_npr"), "plans");
}

export async function listApplications(status: "submitted" | "approved" | "rejected" | "all" = "submitted"): Promise<Application[]> {
  let q = serviceClient().from("tenant_applications").select("*").order("created_at", { ascending: false }).limit(100);
  if (status !== "all") q = q.eq("status", status);
  return must(await q, "applications");
}

export async function getTenantDetail(id: string) {
  const db = serviceClient();
  const [t, subs, invoices, payments, members, invites] = await Promise.all([
    db.from("tenants").select("id, slug, name, legal_name, business_type, status, status_reason, phone, email, pan_number, address_district, address_municipality, created_at").eq("id", id).maybeSingle(),
    db.from("tenant_subscriptions").select("id, starts_on, ends_on, source, price_npr, note, created_at, plans(name, code)").eq("tenant_id", id).order("starts_on", { ascending: false }),
    db.from("platform_invoices").select("id, invoice_no, description, amount_npr, issued_at, due_on, status").eq("tenant_id", id).order("issued_at", { ascending: false }),
    db.from("platform_payments").select("invoice_id, amount_npr, method, reference, received_on").eq("tenant_id", id),
    // Counts and the admin row only: never patients, stock or money of the clinic (D-08).
    db.from("tenant_members").select("id, display_name, email, membership_role, auth_user_id, is_active").eq("tenant_id", id).eq("membership_role", "tenant_admin"),
    db.from("member_invites").select("member_id, expires_at, used_at, revoked_at, created_at").eq("tenant_id", id).order("created_at", { ascending: false }),
  ]);
  const tenant = must(t, "tenant") as Record<string, string> | null;
  if (!tenant) return null;
  const [{ data: paidUntil }, { count: staffCount }, creds, names] = await Promise.all([
    db.rpc("tenant_paid_until", { p_tenant: id }),
    db.from("tenant_members").select("id", { count: "exact", head: true }).eq("tenant_id", id).eq("is_active", true),
    // Registrations (for P-30 verification): staff names and council numbers only.
    db.from("member_credentials").select("id, member_id, profession, council, registration_no, verified_at").eq("tenant_id", id).order("created_at"),
    db.from("tenant_members").select("id, display_name").eq("tenant_id", id),
  ]);
  const memberNames = (must(names, "names") as { id: string; display_name: string }[]);
  const pays = must(payments, "payments") as { invoice_id: string; amount_npr: number }[];
  const inv = (must(invoices, "invoices") as { id: string; amount_npr: number }[]).map((i) => {
    const paid = pays.filter((p) => p.invoice_id === i.id).reduce((s, p) => s + Number(p.amount_npr), 0);
    return { ...i, paid, balance: Number(i.amount_npr) - paid };
  });
  return {
    tenant, paidUntil: (paidUntil as string | null) ?? null, staffCount: staffCount ?? 0,
    subscriptions: must(subs, "subscriptions") as unknown as { id: string; starts_on: string; ends_on: string; source: string; price_npr: number; note: string | null; plans: { name: string; code: string } | null }[],
    invoices: inv as unknown as { id: string; invoice_no: string; description: string; amount_npr: number; issued_at: string; due_on: string | null; status: string; paid: number; balance: number }[],
    admins: must(members, "members") as { id: string; display_name: string; email: string | null; auth_user_id: string | null; is_active: boolean }[],
    credentials: (must(creds, "credentials") as { id: string; member_id: string; profession: string; council: string; registration_no: string; verified_at: string | null }[])
      .map((c) => ({ ...c, member_name: memberNames.find((m) => m.id === c.member_id)?.display_name ?? "?" })),
    invites: must(invites, "invites") as { member_id: string; expires_at: string; used_at: string | null; revoked_at: string | null }[],
  };
}

export async function listTenants() {
  const { data, error } = await serviceClient().from("tenants")
    .select("id, name, slug, status, status_reason, business_type, created_at").order("created_at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  const rows = data as { id: string; name: string; slug: string; status: string; status_reason: string | null; business_type: string; created_at: string }[];
  const paid = await Promise.all(rows.map((r) => serviceClient().rpc("tenant_paid_until", { p_tenant: r.id })));
  return rows.map((r, i) => ({ ...r, paidUntil: (paid[i]!.data as string | null) ?? null }));
}

export const npr = (n: number) => `Rs. ${Number(n).toLocaleString("en-IN")}`;
export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, "").trim().replace(/[\s-]+/g, "-").slice(0, 40).replace(/-$/, "") || "clinic";
}
