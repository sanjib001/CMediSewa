import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { signOutStaff } from "@/app/actions/staff-auth";
import { adToBs, formatBs, isoDate, localDate } from "@/lib/clinic-time";
import { LiveRefresh } from "@/components/notify/live-refresh";

export type TenantBarProps = {
  area: "admin" | "employee";
  tenantName: string;
  displayName: string;
  levelLabel: string;
  showAdminSwitch: boolean;
  unread: number;
  menu?: React.ReactNode;
};

const initials = (name: string) =>
  name.replace(/^dr\.?\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");

/**
 * Top bar shared by the Admin and Employee areas: the clinic, today's date in BS and AD,
 * patient search (wired in B4), the Admin ⇄ workspace switch, and the signed-in person.
 */
export function TenantBar({ area, tenantName, displayName, levelLabel, showAdminSwitch, unread, menu }: TenantBarProps) {
  const today = localDate(new Date());
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
        {menu}
        <Link href={area === "admin" ? "/admin" : "/employee"} className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-control bg-pine text-sm font-bold text-white" aria-hidden>
            {tenantName.trim().charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold leading-tight">{tenantName}</span>
            <span className="block text-sm leading-tight text-ink-faint">
              {formatBs(adToBs(today))} <span className="hidden sm:inline">({isoDate(today)})</span>
            </span>
          </span>
        </Link>

        <label className="ml-auto hidden min-w-0 max-w-sm flex-1 items-center gap-2 rounded-control border border-line bg-canvas px-3 py-2 text-ink-faint md:flex">
          <Icon name="Search" />
          <input type="search" placeholder="Find a patient by name, phone or MRN" aria-label="Find a patient"
            className="w-full bg-transparent text-ink placeholder:text-ink-faint focus:outline-none" />
        </label>

        <nav className="ml-auto flex items-center gap-1 md:ml-2" aria-label="Account">
          {showAdminSwitch ? (
            <Link href={area === "admin" ? "/employee" : "/admin"} className="hidden rounded-control px-3 py-2 text-[0.95rem] font-medium text-pine hover:bg-pine-tint sm:block">
              {area === "admin" ? "Staff workspace" : "Admin"}
            </Link>
          ) : null}
          <Link href="/employee/notifications" className="relative rounded-control p-2 text-ink-soft hover:bg-sunken" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
            <Icon name="Bell" className="size-5" />
            {unread ? <span className="absolute right-0.5 top-0.5 grid min-w-5 place-items-center rounded-full bg-alert px-1 text-xs font-semibold text-white">{unread > 99 ? "99+" : unread}</span> : null}
          </Link>
          <LiveRefresh topics={["notifications"]} />
          <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-control px-1.5 py-1 hover:bg-sunken [&::-webkit-details-marker]:hidden" aria-label="Account menu">
              <span className="grid size-9 place-items-center rounded-full bg-sunken text-sm font-semibold text-ink-soft">{initials(displayName)}</span>
            </summary>
            <div className="absolute right-0 top-12 z-40 w-64 rounded-panel border border-line bg-surface p-2 shadow-lg">
              <div className="px-3 py-2">
                <div className="font-medium">{displayName}</div>
                <div className="text-sm text-ink-faint">{levelLabel}</div>
              </div>
              <Link href="/employee/pin" className="block rounded-control px-3 py-2 text-[0.95rem] hover:bg-sunken">My PIN</Link>
              <form action={signOutStaff}>
                <button type="submit" className="w-full rounded-control px-3 py-2 text-left text-[0.95rem] hover:bg-sunken">Sign out</button>
              </form>
            </div>
          </details>
        </nav>
      </div>
    </header>
  );
}
