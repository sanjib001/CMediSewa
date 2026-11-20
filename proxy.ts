import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session refresh + signed-out redirect. NEVER an authorization decision (HRestroSewa rule):
 * it only asks "is there a valid session at all". The page guards (lib/auth/guards.ts)
 * re-check the platform_admins row and the assurance level on every render.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    }
  );

  // Verifies the JWT and refreshes an expiring session (the refreshed cookies are written
  // back through setAll above). A verification ERROR is not "signed out": pass through and
  // let the page guard decide.
  const { data, error } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const { pathname } = request.nextUrl;

  const redirectTo = (path: string) => {
    const target = NextResponse.redirect(new URL(path, request.url));
    // Keep any cookies the auth adapter just wrote (HRestroSewa: a redirect must not drop
    // a freshly refreshed token).
    for (const c of response.cookies.getAll()) target.cookies.set(c);
    return target;
  };

  const protectedSuperadmin = pathname.startsWith("/superadmin") && !pathname.startsWith("/superadmin/login");
  if (!error && !signedIn && protectedSuperadmin) return redirectTo("/superadmin/login");

  // Signed-out staff go back to THEIR clinic's sign-in link when this device knows it
  // (HRestroSewa's rs_last_slug: inside an installed app there is no URL bar to fix it with).
  const protectedTenant = pathname.startsWith("/admin") || pathname.startsWith("/employee");
  if (!error && !signedIn && protectedTenant) {
    const slug = request.cookies.get("cm_last_tenant")?.value;
    return redirectTo(slug && /^[a-z0-9-]{1,50}$/.test(slug) ? `/login/${slug}` : "/login");
  }

  // Remember the clinic the moment its sign-in link is OPENED (before any sign-in), so the
  // next sign-out or an installed app lands on the right clinic. Harmless if forged: it only
  // picks which sign-in screen to show.
  const linkSlug = pathname.match(/^\/login\/([a-z0-9-]{1,50})$/)?.[1];
  if (linkSlug && linkSlug !== "mfa" && linkSlug !== "verify") {
    response.cookies.set("cm_last_tenant", linkSlug, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 400 * 24 * 3600,
    });
  }
  return response;
}

// MUST be named `config` (HRestroSewa: a differently named export is silently ignored).
// Static assets and the public clinic sites never need a session check.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|c/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
