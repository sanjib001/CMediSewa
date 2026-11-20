import { SUPERADMIN_NAV } from "@/lib/nav";
import { signOutSuperAdmin } from "@/app/actions/superadmin-auth";
import { NavLink } from "./nav-link";

/**
 * Super Admin: deliberately different chrome from the clinic areas (ink bar, no clinic
 * branding) so a platform operator always knows which side of the wall they are on.
 * It never shows patient, stock or money detail of a clinic (D-08).
 */
export function SuperAdminShell({ adminName, children }: { adminName: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="bg-ink text-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-8 px-4 sm:px-6">
          <div className="flex h-14 items-center gap-2 font-semibold">
            CMediSewa <span className="rounded-control bg-white/10 px-2 py-0.5 text-sm font-medium">Platform</span>
          </div>
          <nav aria-label="Platform" className="-mb-px flex gap-5 overflow-x-auto">
            {SUPERADMIN_NAV.map((i) => (
              <NavLink key={i.href} href={i.href} label={i.label} icon={i.icon} variant="top" exact={i.href === "/superadmin"} />
            ))}
          </nav>
          <div className="ml-auto flex h-14 items-center gap-3 text-sm">
            <span className="hidden text-white/80 sm:inline">{adminName}</span>
            <form action={signOutSuperAdmin}>
              <button type="submit" className="rounded-control px-3 py-1.5 font-medium text-white/90 hover:bg-white/10">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
