import { redirect } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { allowedWorkspaces } from "@/lib/nav";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

// Sends each member to their role's home if they may open it, else the first workspace they
// can open (D-56). Someone with no workspace yet sees why instead of a dead end.
export default async function EmployeeHome() {
  const ctx = await requireTenant({ operation: "employee.area", next: "/employee" });
  const ws = allowedWorkspaces(ctx.permissions, ctx.modules);
  const home = ctx.roles.map((r) => r.home_route).find((h) => ws.some((w) => w.href === h));
  const target = home ?? ws[0]?.href;
  if (target) redirect(target);
  return (
    <>
      <PageHeader title={`Welcome, ${ctx.displayName}`} />
      <Panel><p className="text-ink-soft">You don&apos;t have a workspace yet. Ask your clinic admin to give you a role.</p></Panel>
    </>
  );
}
