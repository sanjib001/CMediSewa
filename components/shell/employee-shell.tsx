import type { Workspace } from "@/lib/nav";
import { NavLink } from "./nav-link";
import { TenantBar, type TenantBarProps } from "./tenant-bar";
import { PullToRefresh } from "@/components/pwa/pull-to-refresh";

/**
 * Employee area: the role workspaces (Registrar, OPD, Pharmacy; Lab in Phase 3), filtered to
 * what the member may open. Desktop/tablet: a switcher under the top bar. Phone: bottom tabs.
 */
export function EmployeeShell({
  children, bar, workspaces,
}: { children: React.ReactNode; bar: Omit<TenantBarProps, "menu">; workspaces: Workspace[] }) {
  return (
    <div className="min-h-dvh pb-20 sm:pb-0">
      <TenantBar {...bar} />
      <PullToRefresh />
      {workspaces.length > 1 ? (
        <nav aria-label="Workspaces" className="hidden border-b border-line bg-surface sm:block">
          <ul className="mx-auto flex max-w-[1440px] gap-1 px-4 py-2 sm:px-6">
            {workspaces.map((w) => (
              <li key={w.key}><NavLink href={w.href} label={w.label} icon={w.icon} variant="tab" /></li>
            ))}
          </ul>
        </nav>
      ) : null}
      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">{children}</main>
      {workspaces.length > 1 ? (
        <nav aria-label="Workspaces" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface sm:hidden">
          <ul className="flex">
            {workspaces.map((w) => (
              <li key={w.key} className="flex flex-1"><NavLink href={w.href} label={w.label} icon={w.icon} variant="bottom" /></li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
