import { AuthFrame } from "@/components/auth/auth-frame";
import { SuperAdminLoginForm } from "@/components/auth/superadmin-login-form";

export const metadata = { title: "Platform sign-in" };

// L1 step 1. Lives in its own route group so the (superadmin) layout guard never runs here.
export default async function SuperAdminLogin({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const { denied } = await searchParams;
  return (
    <AuthFrame
      brand={<p className="text-2xl font-semibold">CMediSewa <span className="font-normal text-ink-faint">Platform</span></p>}
      subtitle="Platform administration sign-in"
      footer={<>Clinic staff sign in at their clinic&apos;s own link.</>}
    >
      <SuperAdminLoginForm denied={denied === "1"} />
    </AuthFrame>
  );
}
