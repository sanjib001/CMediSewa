import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/shell/admin-shell";
import { requireTenant } from "@/lib/auth/context";
import { canEnterAdmin, tenantBarProps } from "@/lib/auth/shell-props";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin · CMediSewa" } };
export const dynamic = "force-dynamic";

// Admin area: A2+ (a PIN session steps up first), the tenant admin or a member holding an
// admin-area key. Each page also guards its own permission (D-28): layouts do not re-run on
// client navigation, so a layout check alone is never the authority for a page.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenant({ operation: "admin.area", allowPendingTenant: true, next: "/admin" });
  if (!canEnterAdmin(ctx)) redirect("/employee");
  return (
    <AdminShell bar={await tenantBarProps(ctx, "admin")} permissions={[...ctx.permissions]} modules={[...ctx.modules]}>
      {children}
    </AdminShell>
  );
}
