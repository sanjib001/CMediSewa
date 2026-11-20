import type { Metadata } from "next";
import { SuperAdminShell } from "@/components/shell/superadmin-shell";
import { requireSuperAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: { default: "Platform", template: "%s · Platform · CMediSewa" } };
export const dynamic = "force-dynamic";

// L1 authority: session + active platform_admins row + aal2 (password + authenticator code).
// Each page also calls requireSuperAdmin(): layouts do not re-run on client navigation.
export default async function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  const { admin } = await requireSuperAdmin();
  return <SuperAdminShell adminName={admin.displayName}>{children}</SuperAdminShell>;
}
