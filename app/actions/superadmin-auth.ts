"use server";

import { redirect } from "next/navigation";
import { createSessionClient } from "@/lib/supabase/server";
import { getPlatformAdmin } from "@/lib/auth/current-user";
import { requirePlatformAdminPasswordStep, SUPERADMIN_LOGIN, SUPERADMIN_MFA } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";

export type ActionResult = { ok: true; redirectTo: string } | { ok: false; error: string };

const GENERIC_FAIL = "Email or password is incorrect.";

/**
 * Step 1 of L1: email + password. Only platform admins may continue; anyone else is signed
 * straight back out and gets the SAME message as a wrong password, so this form never reveals
 * which accounts exist or which are admins.
 */
export async function signInSuperAdmin(input: { email: string; password: string }): Promise<ActionResult> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const password = String(input.password ?? "");
  if (!email || !password) return { ok: false, error: "Enter your email and password." };

  const supabase = await createSessionClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    const rateLimited = error?.status === 429;
    const badCredentials = error?.code === "invalid_credentials";
    // Record WHAT Supabase Auth said (code/status/message; never the password), so a
    // misconfiguration (wrong key, unreachable Auth) is not mistaken for a wrong password.
    await audit({ actorKind: "platform_admin", action: "auth.superadmin_signin", outcome: badCredentials ? "denied" : "error",
      reason: rateLimited ? "rate_limited" : badCredentials ? "bad_credentials" : "auth_error",
      detail: { email_domain: email.split("@")[1] ?? null, code: error?.code ?? null, status: error?.status ?? null, message: error?.message?.slice(0, 200) ?? null } });
    if (rateLimited) return { ok: false, error: "Too many attempts. Wait a few minutes and try again." };
    if (badCredentials) return { ok: false, error: GENERIC_FAIL };
    return { ok: false, error: "Sign-in is unavailable right now. Try again, or check the server configuration." };
  }

  const admin = await getPlatformAdmin(data.user.id);
  if (!admin) {
    await supabase.auth.signOut({ scope: "local" });
    await audit({ actorKind: "platform_admin", actorId: data.user.id, action: "auth.superadmin_signin", outcome: "denied", reason: "not_platform_admin" });
    return { ok: false, error: GENERIC_FAIL };
  }

  await audit({ actorKind: "platform_admin", actorId: admin.id, sessionLevel: "A2", action: "auth.superadmin_password", outcome: "success" });
  return { ok: true, redirectTo: SUPERADMIN_MFA };
}

export type MfaState =
  | { mode: "verify"; factorId: string }
  | { mode: "enroll"; factorId: string; qrCode: string; secret: string };

/**
 * Step 2 setup: a verified TOTP factor means "enter your code"; none means "set up your
 * authenticator" (first sign-in). Stale unverified factors from abandoned attempts are
 * removed first, so the QR shown is always the one that will be verified.
 */
export async function prepareSuperAdminMfa(): Promise<MfaState | { error: string }> {
  await requirePlatformAdminPasswordStep();
  const supabase = await createSessionClient();
  const { data: factors, error } = await supabase.auth.mfa.listFactors();
  if (error) return { error: "Could not load your authenticator settings. Try again." };

  const verified = factors.totp.find((f) => f.status === "verified");
  if (verified) return { mode: "verify", factorId: verified.id };

  for (const f of factors.all.filter((f) => f.factor_type === "totp" && f.status !== "verified")) {
    await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error: enrollError } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `CMediSewa ${new Date().toISOString().slice(0, 10)}`,
    issuer: "CMediSewa",
  });
  if (enrollError || !data) return { error: "Could not start authenticator setup. Try again." };
  return { mode: "enroll", factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

/** Step 2: the 6-digit code. Success upgrades the session to aal2 in place (no second session). */
export async function verifySuperAdminMfa(input: { factorId: string; code: string; enrolling: boolean }): Promise<ActionResult> {
  const { admin } = await requirePlatformAdminPasswordStep();
  const code = String(input.code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "Enter the 6-digit code from your authenticator app." };

  const supabase = await createSessionClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: input.factorId, code });
  if (error) {
    await audit({ actorKind: "platform_admin", actorId: admin.id, action: "auth.superadmin_mfa", outcome: "denied", reason: "bad_code" });
    return { ok: false, error: "That code didn't match. Check the time on your phone and try the newest code." };
  }
  await audit({ actorKind: "platform_admin", actorId: admin.id, sessionLevel: "A3",
    action: input.enrolling ? "auth.superadmin_mfa_enrolled" : "auth.superadmin_mfa", outcome: "success" });
  return { ok: true, redirectTo: "/superadmin" };
}

/** Sign out of THIS device only (HRestroSewa lesson: global sign-out broke installed PWAs). */
export async function signOutSuperAdmin(): Promise<void> {
  const supabase = await createSessionClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims?.sub) {
    const admin = await getPlatformAdmin(data.claims.sub).catch(() => null);
    if (admin) await audit({ actorKind: "platform_admin", actorId: admin.id, action: "auth.superadmin_signout" }).catch(() => {});
  }
  await supabase.auth.signOut({ scope: "local" });
  redirect(SUPERADMIN_LOGIN);
}
