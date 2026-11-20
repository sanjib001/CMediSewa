import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * Supabase client bound to the signed-in person's session cookies (publishable key).
 * Used for AUTH ONLY: sign-in, MFA, sign-out, reading claims. Data access goes through
 * the service client, because the browser roles hold no table grants (D-04).
 */
export async function createSessionClient() {
  const store = await cookies();
  return createServerClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. proxy.ts refreshes
          // the session on the next request, so nothing is lost.
        }
      },
    },
  });
}
