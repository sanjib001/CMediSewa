import "server-only";
import { cache } from "react";
import { createSessionClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

export type AuthIdentity = { id: string; email: string | null; aal: "aal1" | "aal2"; sessionId: string | null };

/**
 * Who is asking, resolved once per request (React cache).
 * getClaims() verifies the JWT locally against the project's JWKS when the project uses
 * asymmetric signing keys, and otherwise falls back to the Auth server.
 * A verification ERROR is not "signed out": it rethrows, so a transient fault shows an error
 * instead of silently signing someone out (HRestroSewa lesson). Only a verified absence of a
 * session returns null.
 */
export const getAuthIdentity = cache(async (): Promise<AuthIdentity | null> => {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error) {
    // No session at all is reported as an error by some versions; treat only that as "signed out".
    if (/session/i.test(error.message)) return null;
    throw error;
  }
  const c = data?.claims;
  if (!c?.sub) return null;
  return {
    id: c.sub,
    email: (c.email as string | undefined) ?? null,
    aal: c.aal === "aal2" ? "aal2" : "aal1",
    sessionId: (c.session_id as string | undefined) ?? null,
  };
});

export type PlatformAdmin = { id: string; displayName: string };

/** The caller's active platform_admins row, read LIVE (never cached across requests). */
export const getPlatformAdmin = cache(async (authUserId: string): Promise<PlatformAdmin | null> => {
  const { data, error } = await serviceClient()
    .from("platform_admins")
    .select("id, display_name, is_active")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  // A failed query is not an answer of "not an admin": surface it (HRestroSewa redirect-loop lesson).
  if (error) throw new Error(`platform_admins lookup failed: ${error.code ?? ""} ${error.message}`);
  if (!data || !data.is_active) return null;
  return { id: data.id as string, displayName: data.display_name as string };
});
