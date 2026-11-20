import "server-only";
import { headers } from "next/headers";
import { serviceClient } from "@/lib/supabase/service";
import type { AssuranceLevel } from "@/lib/permissions";

/** The session_id claim of a freshly issued access token (issued by Supabase to us, so trusted). */
export function sessionIdOf(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}

export async function clientIp(): Promise<string | null> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return ip && /^[0-9a-f:.]+$/i.test(ip) ? ip : null;
}

/** Record (or raise) the assurance of a session. Server code only (D-27). */
export async function writeAssurance(row: {
  sessionId: string; authUserId: string; tenantId: string | null; memberId: string | null;
  level: AssuranceLevel; method: "pin" | "password" | "mfa"; deviceId?: string | null;
  passwordAuthAt?: Date | null; reauthAt?: Date | null;
}): Promise<void> {
  const { error } = await serviceClient().from("session_assurance").upsert({
    session_id: row.sessionId,
    auth_user_id: row.authUserId,
    tenant_id: row.tenantId,
    member_id: row.memberId,
    level: row.level,
    method: row.method,
    device_id: row.deviceId ?? null,
    password_auth_at: row.passwordAuthAt?.toISOString() ?? null,
    reauth_at: row.reauthAt?.toISOString() ?? null,
  }, { onConflict: "session_id" });
  if (error) throw new Error(`session_assurance write failed: ${error.code ?? ""} ${error.message}`);
}

/** Only same-site relative paths may be used as a post-sign-in destination (no open redirect). */
export function safeNext(next: unknown, fallback: string): string {
  return typeof next === "string" && /^\/(admin|employee)(\/[A-Za-z0-9_/-]*)?(\?[A-Za-z0-9_=&%-]*)?$/.test(next) ? next : fallback;
}
