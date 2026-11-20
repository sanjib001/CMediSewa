"use server";

import { serviceClient } from "@/lib/supabase/service";
import { createSessionClient } from "@/lib/supabase/server";
import { hmac } from "@/lib/auth/hmac";
import { sessionIdOf, writeAssurance } from "@/lib/auth/session";
import { mfaRequired } from "@/lib/permissions";

export type InviteResult = { ok: true; redirectTo: string } | { ok: false; error: string };

/**
 * Accept a one-time invite (W-01 §5): create the person's auth account with the password they
 * chose, link it to the invited member in ONE database step, sign them in, and send them to
 * the authenticator step (clinic admins must use 2FA, P-11). If linking fails, the just-created
 * auth account is deleted again, so no orphan is left behind.
 */
export async function acceptInvite(input: { token: string; password: string; confirm: string }): Promise<InviteResult> {
  const password = String(input.password ?? "");
  if (password.length < 10) return { ok: false, error: "Use at least 10 characters for your password." };
  if (password !== String(input.confirm ?? "")) return { ok: false, error: "The two passwords don't match." };

  const db = serviceClient();
  const hash = hmac("invite", String(input.token ?? ""));
  const { data: preview } = await db.rpc("invite_preview", { p_token_hash: hash }).maybeSingle<{ member_id: string; email: string | null; username: string | null; tenant_slug: string }>();
  if (!preview) return { ok: false, error: "This invite link has expired or was already used. Ask for a new one." };
  // Username-only staff (P-18) get an internal auth address; they always sign in with their username.
  const email = preview.email ?? `m-${preview.member_id}@users.cmedisewa.internal`;

  const { data: created, error: ce } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (ce || !created.user) {
    if (/already/i.test(ce?.message ?? "")) return { ok: false, error: "An account with this email already exists. Contact CMediSewa support to link it." };
    if (/password/i.test(ce?.message ?? "")) return { ok: false, error: "Choose a stronger password." };
    return { ok: false, error: "Could not create your account. Try again." };
  }
  const { data: linked, error: le } = await db.rpc("accept_invite", { p_token_hash: hash, p_auth_user: created.user.id })
    .single<{ tenant_id: string; member_id: string }>();
  if (le || !linked) {
    await db.auth.admin.deleteUser(created.user.id).catch(() => {});
    return { ok: false, error: "This invite link has expired or was already used. Ask for a new one." };
  }

  const supabase = await createSessionClient();
  await supabase.auth.signOut({ scope: "local" });
  const { data: s, error: se } = await supabase.auth.signInWithPassword({ email, password });
  if (se || !s.session) return { ok: true, redirectTo: `/login/${preview.tenant_slug}` };
  const sessionId = sessionIdOf(s.session.access_token);
  if (sessionId) {
    await writeAssurance({ sessionId, authUserId: created.user.id, tenantId: linked.tenant_id, memberId: linked.member_id,
      level: "A2", method: "password", passwordAuthAt: new Date(), reauthAt: new Date() });
  }
  const { data: m } = await db.from("tenant_members").select("membership_role").eq("id", linked.member_id).single<{ membership_role: string }>();
  const { data: creds } = await db.from("member_credentials").select("profession").eq("member_id", linked.member_id);
  const professions = (creds ?? []).map((c: { profession: string }) => c.profession);
  if (mfaRequired({ membershipRole: m?.membership_role ?? "", professions })) return { ok: true, redirectTo: "/login/mfa" };
  return { ok: true, redirectTo: "/employee" };
}
