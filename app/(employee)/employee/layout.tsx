import type { Metadata } from "next";
import { EmployeeShell } from "@/components/shell/employee-shell";
import { requireTenant } from "@/lib/auth/context";
import { tenantBarProps } from "@/lib/auth/shell-props";
import { allowedWorkspaces } from "@/lib/nav";

export const metadata: Metadata = { title: { default: "Staff", template: "%s · CMediSewa" } };
export const dynamic = "force-dynamic";

// Employee area: A1+ (PIN is enough here). Each workspace page checks its own entry keys,
// and each operation its assurance level (permissions.md §3).
export default async function EmployeeLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenant({ operation: "employee.area", next: "/employee" });
  return (
    <EmployeeShell bar={await tenantBarProps(ctx, "employee")} workspaces={allowedWorkspaces(ctx.permissions, ctx.modules)}>
      {children}
    </EmployeeShell>
  );
}
