"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { serviceClient } from "@/lib/supabase/service";
import { hmac, newToken } from "@/lib/auth/hmac";

// Super Admin actions (B2). Every one starts with requireSuperAdmin(): session + active
// platform_admins row + aal2. Writes go through the SECURITY DEFINER functions of migration
// 0014, which validate and audit. None of these touch a clinic's patients, stock or money.

export type FormResult = { ok: true; message?: string; link?: string } | { ok: false; error: string };

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const n = (fd: FormData, k: string) => Number(s(fd, k));

const ERRORS: Record<string, string> = {
  APPLICATION_NOT_OPEN: "This application has already been handled.",
  SLUG_TAKEN: "That clinic link is already taken. Choose another.",
  PLAN_NOT_FOUND: "Choose an active plan.",
  REASON_REQUIRED: "A reason is required.",
  TENANT_CLOSED: "A closed clinic cannot change status.",
  OVERPAYMENT: "That payment is more than the invoice's balance.",
  INVOICE_VOID: "That invoice is void.",
  MEMBER_NOT_INVITABLE: "This person has already accepted their invite.",
  CREDENTIAL_NOT_FOUND: "That registration was not found.",
};
function friendly(e: { message?: string } | null): string {
  const code = Object.keys(ERRORS).find((k) => e?.message?.includes(k));
  if (code) return ERRORS[code]!;
  if (e?.message?.includes("tenants_slug")) return "That clinic link is not allowed. Use 2–50 lowercase letters, numbers or hyphens.";
  return "Something went wrong. Nothing was changed.";
}

async function inviteLink(token: string): Promise<string> {
  const h = await headers();
  const base = process.env.NEXT_PUBLIC_APP_URL || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  return `${base.replace(/\/$/, "")}/invite/${token}`;
}

// ── plans ─────────────────────────────────────────────────────────────────────
export async function savePlan(fd: FormData): Promise<FormResult> {
  await requireSuperAdmin();
  const id = s(fd, "id") || null;
  const row = {
    code: s(fd, "code").toLowerCase(),
    name: s(fd, "name"),
    description: s(fd, "description") || null,
    price_npr: n(fd, "price_npr"),
    billing_cycle_days: n(fd, "billing_cycle_days") || 365,
    max_doctors: n(fd, "max_doctors") || null,
    max_members: n(fd, "max_members") || null,
    features: fd.getAll("features").map(String).filter((f) => ["lab", "sms", "multi_store"].includes(f)),
    is_public: fd.get("is_public") === "on",
    is_active: fd.get("is_active") !== null ? fd.get("is_active") === "on" : true,
  };
  if (!/^[a-z0-9-]{2,40}$/.test(row.code)) return { ok: false, error: "Code: 2–40 lowercase letters, numbers or hyphens." };
  if (row.name.length < 2) return { ok: false, error: "Give the plan a name." };
  if (!Number.isFinite(row.price_npr) || row.price_npr < 0) return { ok: false, error: "Price must be zero or more." };
  const db = serviceClient();
  const { error } = id ? await db.from("plans").update(row).eq("id", id) : await db.from("plans").insert(row);
  if (error) return { ok: false, error: error.code === "23505" ? "A plan with that code already exists." : "Could not save the plan." };
  revalidatePath("/superadmin/plans");
  revalidatePath("/");
  return { ok: true, message: id ? "Plan updated." : "Plan created." };
}

// ── applications ──────────────────────────────────────────────────────────────
export async function approveApplication(fd: FormData): Promise<FormResult> {
  const { admin } = await requireSuperAdmin();
  const slug = s(fd, "slug").toLowerCase();
  const days = n(fd, "period_days");
  const source = s(fd, "source");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(slug)) return { ok: false, error: "Clinic link: lowercase letters, numbers and hyphens (2–50)." };
  if (!Number.isInteger(days) || days < 1 || days > 1100) return { ok: false, error: "Period must be 1–1100 days." };
  if (!["trial", "paid", "complimentary"].includes(source)) return { ok: false, error: "Choose trial, paid or complimentary." };
  const token = newToken();
  const { error } = await serviceClient().rpc("provision_tenant", {
    p_application: s(fd, "application_id"), p_slug: slug, p_plan: s(fd, "plan_id"),
    p_starts_on: s(fd, "starts_on"), p_period_days: days, p_source: source,
    p_invite_token_hash: hmac("invite", token), p_by: admin.id,
  });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath("/superadmin");
  revalidatePath("/superadmin/applications");
  return { ok: true, message: "Clinic created. Send this one-time link to the clinic admin. It expires in 7 days and is shown only now.", link: await inviteLink(token) };
}

export async function rejectApplication(fd: FormData): Promise<FormResult> {
  const { admin } = await requireSuperAdmin();
  const { error } = await serviceClient().rpc("reject_tenant_application", { p_application: s(fd, "application_id"), p_reason: s(fd, "reason"), p_by: admin.id });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath("/superadmin/applications");
  return { ok: true, message: "Application rejected." };
}

// ── tenant lifecycle & billing ────────────────────────────────────────────────
export async function setTenantStatus(fd: FormData): Promise<FormResult> {
  const { admin } = await requireSuperAdmin();
  const status = s(fd, "status");
  if (!["active", "suspended", "closed"].includes(status)) return { ok: false, error: "Choose a status." };
  const { error } = await serviceClient().rpc("set_tenant_status", { p_tenant: s(fd, "tenant_id"), p_status: status, p_reason: s(fd, "reason"), p_by: admin.id });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath(`/superadmin/tenants/${s(fd, "tenant_id")}`);
  return { ok: true, message: `Clinic is now ${status}.` };
}

export async function addSubscription(fd: FormData): Promise<FormResult> {
  const { admin } = await requireSuperAdmin();
  const starts = s(fd, "starts_on");
  const days = n(fd, "period_days");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(starts) || !Number.isInteger(days) || days < 1 || days > 1100) return { ok: false, error: "Enter a start date and 1–1100 days." };
  const ends = new Date(`${starts}T00:00:00Z`);
  ends.setUTCDate(ends.getUTCDate() + days - 1);
  const { error } = await serviceClient().rpc("add_subscription_period", {
    p_tenant: s(fd, "tenant_id"), p_plan: s(fd, "plan_id"), p_starts_on: starts, p_ends_on: ends.toISOString().slice(0, 10),
    p_source: s(fd, "source") || "paid", p_price: n(fd, "price_npr") || 0, p_note: s(fd, "note") || null, p_by: admin.id,
  });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath(`/superadmin/tenants/${s(fd, "tenant_id")}`);
  return { ok: true, message: "Subscription period added." };
}

export async function issueInvoice(fd: FormData): Promise<FormResult> {
  const { admin } = await requireSuperAdmin();
  const amount = n(fd, "amount_npr");
  if (!(amount > 0)) return { ok: false, error: "Amount must be more than zero." };
  if (!s(fd, "description")) return { ok: false, error: "Describe what the invoice is for." };
  const { error } = await serviceClient().rpc("issue_platform_invoice", {
    p_tenant: s(fd, "tenant_id"), p_subscription: null, p_description: s(fd, "description"), p_amount: amount,
    p_due_on: s(fd, "due_on") || null, p_by: admin.id,
  });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath(`/superadmin/tenants/${s(fd, "tenant_id")}`);
  return { ok: true, message: "Invoice issued." };
}

export async function recordPayment(fd: FormData): Promise<FormResult> {
  const { admin } = await requireSuperAdmin();
  const amount = n(fd, "amount_npr");
  if (!(amount > 0)) return { ok: false, error: "Amount must be more than zero." };
  const { error } = await serviceClient().rpc("record_platform_payment", {
    p_invoice: s(fd, "invoice_id"), p_amount: amount, p_method: s(fd, "method"), p_reference: s(fd, "reference"),
    p_received_on: s(fd, "received_on"), p_by: admin.id,
  });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath(`/superadmin/tenants/${s(fd, "tenant_id")}`);
  return { ok: true, message: "Payment recorded." };
}

export async function reissueAdminInvite(fd: FormData): Promise<FormResult> {
  const { admin } = await requireSuperAdmin();
  const token = newToken();
  const { error } = await serviceClient().rpc("reissue_invite", {
    p_tenant: s(fd, "tenant_id"), p_member: s(fd, "member_id"), p_token_hash: hmac("invite", token), p_by_admin: admin.id,
  });
  if (error) return { ok: false, error: friendly(error) };
  return { ok: true, message: "New invite link. The previous link no longer works. Shown only now.", link: await inviteLink(token) };
}

/** P-30: CMediSewa verifies a registration (e.g. the clinic's only doctor-admin's own NMC). */
export async function verifyCredentialAsPlatform(fd: FormData): Promise<FormResult> {
  const { admin } = await requireSuperAdmin();
  const id = s(fd, "credential_id");
  const db = serviceClient();
  const { data: c } = await db.from("member_credentials").select("id").eq("tenant_id", s(fd, "tenant_id")).eq("id", id).maybeSingle();
  if (!c) return { ok: false, error: "That registration was not found." };
  const { error } = await db.rpc("verify_member_credential", { p_credential: id, p_verifier_member: null, p_verifier_platform_admin: admin.id });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath(`/superadmin/tenants/${s(fd, "tenant_id")}`);
  return { ok: true, message: "Verified." };
}
