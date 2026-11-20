import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth/auth-frame";
import { TotpForm } from "@/components/auth/totp-form";
import { prepareStaffMfa, verifyStaffMfa, signOutStaff } from "@/app/actions/staff-auth";
import { getTenantContext, homeFor, staffLoginPath } from "@/lib/auth/context";

export const metadata = { title: "Verify it's you" };
export const dynamic = "force-dynamic";

// P-11: clinic admins and doctors finish sign-in with an authenticator code.
export default async function StaffMfa() {
  const ctx = await getTenantContext();
  if (!ctx) redirect(await staffLoginPath());
  if (ctx.identity.aal === "aal2") redirect(homeFor(ctx));
  const state = await prepareStaffMfa();
  return (
    <AuthFrame brand={<p className="text-xl font-semibold">{ctx.tenantName}</p>} subtitle={ctx.displayName}>
      {"error" in state ? <p role="alert" className="text-alert">{state.error}</p> : <TotpForm state={state} verify={verifyStaffMfa} signOut={signOutStaff} />}
    </AuthFrame>
  );
}
