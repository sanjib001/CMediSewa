"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { createSessionClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { getAuthIdentity } from "@/lib/auth/current-user";
import { getTenantContext, homeFor, requireTenant, staffLoginPath } from "@/lib/auth/context";
import { hmac, newToken, DEVICE_COOKIE, LAST_TENANT_COOKIE } from "@/lib/auth/hmac";
import { sessionIdOf, clientIp, writeAssurance, safeNext } from "@/lib/auth/session";
import { mfaRequired, pinProblem } from "@/lib/permissions";
import { audit } from "@/lib/audit";

export type ActionResult = { ok: true; redirectTo: string } | { ok: false; error: string };
const GENERIC_FAIL = "Your login or password is incorrect.";
const COOKIE_BASE = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };
const YEAR_ISH = 400 * 24 * 3600; // browsers cap cookies at 400 days

async function tenantBySlug(slug: string) {
  const { data, error } = await serviceClient()
    .from("tenants").select("id, slug, name, status").eq("slug", slug).neq("status", "closed").maybeSingle();
  if (error) throw new Error(`tenant lookup failed: ${error.message}`);
  return data as { id: string; slug: string; name: string; status: string } | null;
}

async function rememberTenant(slug: string) {
  (await cookies()).set(LAST_TENANT_COOKIE, slug, { ...COOKIE_BASE, maxAge: YEAR_ISH });
}

type RawCtx = { member_id: string; tenant_id: string; membership_role: "tenant_admin" | "tenant_member";
  roles: { name: string; home_route: string; template_key: string | null }[]; professions: string[] } | null;

async function contextFor(authUserId: string, sessionId: string | null, tenantId: string | null): Promise<RawCtx> {
  const { data, error } = await serviceClient().rpc("resolve_request_context", { p_auth_user: authUserId, p_session: sessionId, p_tenant: tenantId });
  if (error) throw new Error(`resolve_request_context failed: ${error.message}`);
  return data as RawCtx;
}

// ── L2 / L3: email or username + password ─────────────────────────────────────
export async function signInStaff(input: { login: string; password: string; slug?: string | null }): Promise<ActionResult> {
  const login = String(input.login ?? "").trim().toLowerCase();
  const password = String(input.password ?? "");
  const slug = input.slug ? String(input.slug) : null;
  if (!login || !password) return { ok: false, error: "Enter your login and password." };

  const loginHash = hmac("login", login);
  const db = serviceClient();
  const ip = await clientIp();
  const { data: lock } = await db.rpc("password_lockout_status", { p_login_hash: loginHash }).single<{ locked: boolean; retry_after: string | null }>();
  if (lock?.locked) {
    await audit({ actorKind: "member", action: "auth.staff_signin", outcome: "denied", reason: "locked_out" });
    return { ok: false, error: "Too many wrong attempts. Wait 15 minutes, or ask your clinic admin." };
  }

  const tenant = slug ? await tenantBySlug(slug) : null;
  if (slug && !tenant) return { ok: false, error: GENERIC_FAIL };

  // A username is resolved inside ONE clinic only (P-18), so the clinic link is required.
  let email = login;
  if (!login.includes("@")) {
    if (!tenant) return { ok: false, error: "To sign in with a username, open your clinic's own sign-in link." };
    const { data: m } = await db.from("tenant_members").select("auth_user_id")
      .eq("tenant_id", tenant.id).ilike("username", login).eq("is_active", true).is("deleted_at", null).maybeSingle();
    const authId = (m as { auth_user_id: string | null } | null)?.auth_user_id;
    const user = authId ? (await db.auth.admin.getUserById(authId)).data.user : null;
    if (!user?.email) {
      await db.rpc("record_login_attempt", { p_login_hash: loginHash, p_success: false, p_ip: ip });
      await audit({ tenantId: tenant.id, actorKind: "member", action: "auth.staff_signin", outcome: "denied", reason: "bad_credentials" });
      return { ok: false, error: GENERIC_FAIL };
    }
    email = user.email;
  }

  const supabase = await createSessionClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    const bad = error?.code === "invalid_credentials";
    await db.rpc("record_login_attempt", { p_login_hash: loginHash, p_success: false, p_ip: ip });
    await audit({ tenantId: tenant?.id ?? null, actorKind: "member", action: "auth.staff_signin", outcome: bad ? "denied" : "error",
      reason: error?.status === 429 ? "rate_limited" : bad ? "bad_credentials" : "auth_error",
      detail: { code: error?.code ?? null, status: error?.status ?? null } });
    if (error?.status === 429) return { ok: false, error: "Too many attempts. Wait a few minutes and try again." };
    return { ok: false, error: bad || !error ? GENERIC_FAIL : "Sign-in is unavailable right now. Try again shortly." };
  }

  const sessionId = sessionIdOf(data.session.access_token);
  const ctx = await contextFor(data.user.id, sessionId, tenant?.id ?? null);
  if (!ctx || !sessionId) {
    await supabase.auth.signOut({ scope: "local" });
    await audit({ tenantId: tenant?.id ?? null, actorKind: "member", actorId: null, action: "auth.staff_signin", outcome: "denied", reason: "no_membership" });
    return { ok: false, error: tenant ? `This account has no access to ${tenant.name}.` : "This account has no clinic access." };
  }

  await db.rpc("record_login_attempt", { p_login_hash: loginHash, p_success: true, p_ip: ip });
  await writeAssurance({ sessionId, authUserId: data.user.id, tenantId: ctx.tenant_id, memberId: ctx.member_id,
    level: "A2", method: "password", passwordAuthAt: new Date(), reauthAt: new Date() });
  await db.from("tenant_members").update({ last_active_at: new Date().toISOString() }).eq("id", ctx.member_id);
  await audit({ tenantId: ctx.tenant_id, actorKind: "member", actorId: ctx.member_id, sessionLevel: "A2", action: "auth.staff_password", outcome: "success" });
  const { data: t } = await db.from("tenants").select("slug").eq("id", ctx.tenant_id).single<{ slug: string }>();
  if (t) await rememberTenant(t.slug);

  if (mfaRequired({ membershipRole: ctx.membership_role, professions: ctx.professions })) return { ok: true, redirectTo: "/login/mfa" };
  return { ok: true, redirectTo: homeFor({ membershipRole: ctx.membership_role, roles: ctx.roles, level: "A2" }) };
}

// ── MFA for clinic admins and doctors (P-11) ──────────────────────────────────
export type MfaState =
  | { mode: "verify"; factorId: string }
  | { mode: "enroll"; factorId: string; qrCode: string; secret: string };

export async function prepareStaffMfa(): Promise<MfaState | { error: string }> {
  const ctx = await getTenantContext();
  if (!ctx) redirect(await staffLoginPath());
  const supabase = await createSessionClient();
  const { data: factors, error } = await supabase.auth.mfa.listFactors();
  if (error) return { error: "Could not load your authenticator settings. Try again." };
  const verified = factors.totp.find((f) => f.status === "verified");
  if (verified) return { mode: "verify", factorId: verified.id };
  for (const f of factors.all.filter((f) => f.factor_type === "totp" && f.status !== "verified")) {
    await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error: enrollError } = await supabase.auth.mfa.enroll({
    factorType: "totp", friendlyName: `${ctx.tenantName} ${new Date().toISOString().slice(0, 10)}`, issuer: "CMediSewa",
  });
  if (enrollError || !data) return { error: "Could not start authenticator setup. Try again." };
  return { mode: "enroll", factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

export async function verifyStaffMfa(input: { factorId: string; code: string; enrolling: boolean }): Promise<ActionResult> {
  const ctx = await getTenantContext();
  if (!ctx || !ctx.identity.sessionId) return { ok: false, error: "Your session ended. Sign in again." };
  const code = String(input.code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "Enter the 6-digit code from your authenticator app." };
  const supabase = await createSessionClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: input.factorId, code });
  if (error) {
    await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, action: "auth.staff_mfa", outcome: "denied", reason: "bad_code" });
    return { ok: false, error: "That code didn't match. Check the time on your phone and try the newest code." };
  }
  await writeAssurance({ sessionId: ctx.identity.sessionId, authUserId: ctx.identity.id, tenantId: ctx.tenantId, memberId: ctx.memberId,
    level: "A3", method: "mfa", deviceId: ctx.deviceId, passwordAuthAt: ctx.passwordAuthAt ?? new Date(), reauthAt: new Date() });
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: "A3",
    action: input.enrolling ? "auth.staff_mfa_enrolled" : "auth.staff_mfa", outcome: "success" });
  return { ok: true, redirectTo: homeFor({ membershipRole: ctx.membershipRole, roles: ctx.roles, level: "A3" }) };
}

// ── L4: clinic link + PIN on a trusted device ─────────────────────────────────
const PIN_ERRORS: Record<string, string> = {
  BAD_PIN: "That PIN didn't match.",
  PIN_LOCKED: "Too many wrong PINs. Wait 15 minutes, or sign in with your password.",
  PIN_NOT_SET: "Your PIN needs to be set again. Sign in with your password first.",
  DEVICE_NOT_TRUSTED: "This device isn't set up for PIN sign-in. Use your password.",
  DEVICE_THROTTLED: "Too many wrong PINs on this device. Use your password.",
  NOT_ALLOWED: "PIN sign-in isn't available for you on this device. Use your password.",
};

export async function pinSignIn(input: { slug: string; memberId: string; pin: string }): Promise<ActionResult> {
  const tenant = await tenantBySlug(String(input.slug));
  if (!tenant) return { ok: false, error: PIN_ERRORS.DEVICE_NOT_TRUSTED! };
  const token = (await cookies()).get(DEVICE_COOKIE)?.value;
  if (!token) return { ok: false, error: PIN_ERRORS.DEVICE_NOT_TRUSTED! };
  const pin = String(input.pin ?? "");
  if (!/^\d{6}$/.test(pin)) return { ok: false, error: "Enter your 6-digit PIN." };

  const db = serviceClient();
  const { data: v, error } = await db.rpc("verify_pin", {
    p_tenant: tenant.id, p_member: input.memberId, p_pin: pin, p_device_token_hash: hmac("device", token), p_ip: await clientIp(),
  }).single<{ ok: boolean; reason: string | null; auth_user_id: string | null; device_id: string | null }>();
  if (error || !v) throw new Error(`verify_pin failed: ${error?.message}`);
  if (!v.ok || !v.auth_user_id) {
    await audit({ tenantId: tenant.id, actorKind: "member", actorId: input.memberId, action: "auth.pin_signin", outcome: "denied", reason: v.reason ?? "unknown" });
    return { ok: false, error: PIN_ERRORS[v.reason ?? ""] ?? "PIN sign-in failed." };
  }

  // One person per device: whoever was signed in here is signed out first (local scope).
  const supabase = await createSessionClient();
  await supabase.auth.signOut({ scope: "local" });

  // P-23 (proven by spike): mint a normal session for that same identity, server-side.
  const { data: u } = await db.auth.admin.getUserById(v.auth_user_id);
  if (!u.user?.email) throw new Error("member has no auth email");
  const { data: link, error: le } = await db.auth.admin.generateLink({ type: "magiclink", email: u.user.email });
  if (le || !link.properties?.hashed_token) throw new Error(`session minting failed: ${le?.message}`);
  const { data: s, error: se } = await supabase.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" });
  if (se || !s.session) throw new Error(`session minting failed: ${se?.message}`);

  const sessionId = sessionIdOf(s.session.access_token)!;
  await writeAssurance({ sessionId, authUserId: v.auth_user_id, tenantId: tenant.id, memberId: input.memberId,
    level: "A1", method: "pin", deviceId: v.device_id });
  await db.from("tenant_members").update({ last_active_at: new Date().toISOString() }).eq("id", input.memberId);
  await audit({ tenantId: tenant.id, actorKind: "member", actorId: input.memberId, sessionLevel: "A1", action: "auth.pin_signin", outcome: "success" });
  await rememberTenant(tenant.slug);
  const ctx = await contextFor(v.auth_user_id, sessionId, tenant.id);
  return { ok: true, redirectTo: ctx?.roles[0]?.home_route ?? "/employee/registrar" };
}

// ── L6: step-up (password again) without a second session ─────────────────────
export async function stepUpPassword(input: { password: string; next?: string }): Promise<ActionResult> {
  const ctx = await getTenantContext();
  if (!ctx || !ctx.identity.sessionId || !ctx.identity.email) return { ok: false, error: "Your session ended. Sign in again." };
  const db = serviceClient();
  const loginHash = hmac("login", ctx.identity.email.toLowerCase());
  const { data: lock } = await db.rpc("password_lockout_status", { p_login_hash: loginHash }).single<{ locked: boolean }>();
  if (lock?.locked) return { ok: false, error: "Too many wrong attempts. Wait 15 minutes." };

  // Check the password on a throwaway, cookie-less client, then discard that session.
  const probe = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await probe.auth.signInWithPassword({ email: ctx.identity.email, password: String(input.password ?? "") });
  if (error || !data.user || data.user.id !== ctx.identity.id) {
    await db.rpc("record_login_attempt", { p_login_hash: loginHash, p_success: false, p_ip: await clientIp() });
    await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, action: "auth.step_up", outcome: "denied" });
    return { ok: false, error: "That password is incorrect." };
  }
  await probe.auth.signOut({ scope: "local" });
  await db.rpc("record_login_attempt", { p_login_hash: loginHash, p_success: true, p_ip: await clientIp() });

  const level = ctx.identity.aal === "aal2" ? "A3" : "A2";
  await writeAssurance({ sessionId: ctx.identity.sessionId, authUserId: ctx.identity.id, tenantId: ctx.tenantId, memberId: ctx.memberId,
    level, method: level === "A3" ? "mfa" : "password", deviceId: ctx.deviceId, passwordAuthAt: new Date(), reauthAt: new Date() });
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: level, action: "auth.step_up", outcome: "success" });
  // Someone who must use 2FA finishes at the MFA step before reaching A2+ pages.
  if (ctx.mfaRequired && ctx.identity.aal !== "aal2") return { ok: true, redirectTo: "/login/mfa" };
  return { ok: true, redirectTo: safeNext(input.next, homeFor({ ...ctx, level })) };
}

// ── PIN self-service (from a password session only) ───────────────────────────
export async function setMyPin(input: { pin: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireTenant({ operation: "admin.area", allowPendingTenant: true, next: "/employee/pin" });
  const problem = pinProblem(String(input.pin ?? ""));
  if (problem) return { ok: false, error: problem };
  const { error } = await serviceClient().rpc("set_member_pin", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_pin: input.pin });
  if (error) return { ok: false, error: error.message.includes("PIN_TOO_SIMPLE") ? "Choose a less obvious PIN." : "Could not save your PIN." };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "member.pin_set" });
  return { ok: true };
}

// ── Trusted devices (admin, A3 or recent re-auth: permissions.md §3) ───────────
export async function trustThisDevice(input: { name: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireTenant({ operation: "devices.manage", permission: "manage_staff", next: "/admin/devices" });
  const name = String(input.name ?? "").trim();
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the device a name, like “Reception PC”." };
  const token = newToken();
  const { error } = await serviceClient().rpc("enroll_trusted_device", {
    p_tenant: ctx.tenantId, p_name: name, p_token_hash: hmac("device", token), p_by: ctx.memberId,
  });
  if (error) return { ok: false, error: "Could not trust this device." };
  (await cookies()).set(DEVICE_COOKIE, token, { ...COOKIE_BASE, maxAge: YEAR_ISH });
  return { ok: true };
}

export async function revokeDevice(input: { deviceId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireTenant({ operation: "devices.manage", permission: "manage_staff", next: "/admin/devices" });
  const { error } = await serviceClient().rpc("revoke_trusted_device", { p_tenant: ctx.tenantId, p_device: input.deviceId, p_by: ctx.memberId });
  if (error) return { ok: false, error: "Could not revoke that device." };
  return { ok: true };
}

// ── L8: sign out of this device ───────────────────────────────────────────────
/** Sign out on this device. The idle lock passes "idle"; the Sign out button (a form) passes FormData. */
export async function signOutStaff(why?: unknown): Promise<void> {
  const reason = why === "idle" ? "idle" : "manual";
  const identity = await getAuthIdentity();
  const ctx = identity ? await getTenantContext().catch(() => null) : null;
  const supabase = await createSessionClient();
  if (identity?.sessionId) await serviceClient().from("session_assurance").delete().eq("session_id", identity.sessionId);
  if (ctx) await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, action: "auth.staff_signout", detail: { reason, idle_lock_minutes: ctx.idleLockMinutes, trusted_device: Boolean(ctx.deviceId) } }).catch(() => {});
  await supabase.auth.signOut({ scope: "local" });
  redirect(`${await staffLoginPath()}${reason === "idle" ? "?idle=1" : ""}`);
}
