import "server-only";
import { redirect } from "next/navigation";
import { getAuthIdentity, getPlatformAdmin, type PlatformAdmin, type AuthIdentity } from "./current-user";

export const SUPERADMIN_LOGIN = "/superadmin/login";
export const SUPERADMIN_MFA = "/superadmin/login/mfa";

/**
 * The Super Admin authority (L1). All three must hold, checked on every request:
 *   1. a verified session,
 *   2. an ACTIVE platform_admins row (live; deactivation is immediate),
 *   3. assurance level aal2: password + authenticator code. TOTP is mandatory for this role.
 * proxy.ts only redirects signed-out visitors; THIS is the authority.
 */
export async function requireSuperAdmin(): Promise<{ identity: AuthIdentity; admin: PlatformAdmin }> {
  const identity = await getAuthIdentity();
  if (!identity) redirect(SUPERADMIN_LOGIN);
  const admin = await getPlatformAdmin(identity.id);
  if (!admin) redirect(`${SUPERADMIN_LOGIN}?denied=1`);
  if (identity.aal !== "aal2") redirect(SUPERADMIN_MFA);
  return { identity, admin };
}

/** For the MFA step: signed in with a password and a platform admin, but not yet aal2. */
export async function requirePlatformAdminPasswordStep(): Promise<{ identity: AuthIdentity; admin: PlatformAdmin }> {
  const identity = await getAuthIdentity();
  if (!identity) redirect(SUPERADMIN_LOGIN);
  const admin = await getPlatformAdmin(identity.id);
  if (!admin) redirect(`${SUPERADMIN_LOGIN}?denied=1`);
  return { identity, admin };
}
