import { ADMIN_NAV, type NavGroup } from "@/lib/nav";
import { NavLink } from "./nav-link";
import { TenantBar, type TenantBarProps } from "./tenant-bar";
import { MobileDrawer } from "./mobile-drawer";

function Sidebar({ groups }: { groups: NavGroup[] }) {
  return (
    <nav aria-label="Admin" className="space-y-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="px-3 pb-1.5 text-sm font-medium text-ink-soft">{group.label}</p>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.href}>
                <NavLink href={item.href} label={item.label} icon={item.icon} exact={item.href === "/admin"} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Admin area: back-office for the tenant admin and permitted staff (D-56, D-28). */
export function AdminShell({
  children, bar, permissions, modules,
}: { children: React.ReactNode; bar: Omit<TenantBarProps, "menu">; permissions: string[]; modules: string[] }) {
  // Navigation = guards: an item shows only if its module is on and the member holds its key.
  const groups = ADMIN_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => (!i.module || modules.includes(i.module)) && (!i.permission || permissions.includes(i.permission))
      && (!i.anyOf || i.anyOf.some((k) => permissions.includes(k)))),
  })).filter((g) => g.items.length > 0);
  // Phones and tablets: the same menu in a side drawer, with patient search and the area switch.
  const mobileMenu = (
    <MobileDrawer title={bar.tenantName} subtitle={bar.displayName} searchHref={bar.searchHref}
      switchLink={bar.showAdminSwitch ? { href: "/employee", label: "Staff workspace" } : null}>
      <Sidebar groups={groups} />
    </MobileDrawer>
  );
  return (
    <div className="min-h-dvh">
      <TenantBar {...bar} menu={mobileMenu} />
      <div className="mx-auto flex max-w-[1440px]">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-64 shrink-0 overflow-y-auto border-r border-line px-3 py-6 lg:block">
          <Sidebar groups={groups} />
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
