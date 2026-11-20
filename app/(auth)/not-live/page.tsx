import { redirect } from "next/navigation";
import { getTenantContext, staffLoginPath } from "@/lib/auth/context";
import { AuthFrame } from "@/components/auth/auth-frame";
import { signOutStaff } from "@/app/actions/staff-auth";

export const metadata = { title: "Not live yet", robots: { index: false } };
export const dynamic = "force-dynamic";

// Staff of a clinic that hasn't gone live yet land here instead of their workspace.
export default async function NotLive() {
  const ctx = await getTenantContext();
  if (!ctx) redirect(await staffLoginPath());
  if (ctx.tenantStatus !== "pending") redirect(ctx.membershipRole === "tenant_admin" ? "/admin" : "/employee");
  return (
    <AuthFrame brand={<p className="text-xl font-semibold">{ctx.tenantName}</p>} subtitle={`Welcome, ${ctx.displayName}`}>
      <div className="space-y-4">
        <p className="text-ink-soft">Your account is ready, but the clinic isn&apos;t live on CMediSewa yet. Your clinic admin is finishing the setup. You&apos;ll be able to work as soon as they press &ldquo;Go live&rdquo;.</p>
        <form action={async () => { "use server"; await signOutStaff(); }}>
          <button type="submit" className="text-sm font-medium text-pine hover:underline">Sign out</button>
        </form>
      </div>
    </AuthFrame>
  );
}
