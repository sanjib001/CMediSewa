import Link from "next/link";
import { AuthFrame } from "@/components/auth/auth-frame";
import { StaffLoginForm } from "@/components/auth/staff-login-form";

export const metadata = { title: "Sign in" };

const NOTICES: Record<string, string> = {
  no_access: "This account has no clinic access. Ask your clinic admin.",
  suspended: "This clinic's account is suspended. The clinic admin can still sign in to export data.",
};

// L2 (architecture.md §6a). Username sign-in needs the clinic's own link (P-18).
export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const notice = sp.no_access ? NOTICES.no_access : sp.suspended ? NOTICES.suspended : null;
  return (
    <AuthFrame
      brand={<p className="text-2xl font-semibold">CMediSewa</p>}
      subtitle="Sign in to your clinic"
      footer={<>Staff with a username or PIN: open your clinic&apos;s own sign-in link. <Link href="/" className="text-pine hover:underline">CMediSewa</Link></>}
    >
      <StaffLoginForm notice={notice} />
    </AuthFrame>
  );
}
