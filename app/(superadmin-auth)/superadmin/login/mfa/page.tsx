import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth/auth-frame";
import { TotpForm } from "@/components/auth/totp-form";
import { prepareSuperAdminMfa, verifySuperAdminMfa, signOutSuperAdmin } from "@/app/actions/superadmin-auth";
import { requirePlatformAdminPasswordStep } from "@/lib/auth/guards";

export const metadata = { title: "Verify it's you" };
export const dynamic = "force-dynamic";

// L1 step 2: authenticator code (mandatory for platform admins).
export default async function SuperAdminMfa() {
  const { identity } = await requirePlatformAdminPasswordStep();
  if (identity.aal === "aal2") redirect("/superadmin");
  const state = await prepareSuperAdminMfa();
  return (
    <AuthFrame
      brand={<p className="text-2xl font-semibold">CMediSewa <span className="font-normal text-ink-faint">Platform</span></p>}
      subtitle={identity.email ?? undefined}
    >
      {"error" in state ? <p role="alert" className="text-alert">{state.error}</p> : <TotpForm state={state} verify={verifySuperAdminMfa} signOut={signOutSuperAdmin} />}
    </AuthFrame>
  );
}
