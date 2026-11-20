import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * service_role client (secret key). SERVER ONLY: the `server-only` import makes any client
 * bundle that reaches this module fail the build, and CI greps bundles for the key.
 * Bypasses RLS, so every caller scopes its own queries (tenant_id from the verified
 * context, never from the request).
 */
export function serviceClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}
