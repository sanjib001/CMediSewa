"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icon";

/**
 * Phones and tablets: the admin menu as a side drawer (owner: "more responsive and mobile
 * friendly"). A native <dialog> opened with showModal(): focus stays inside, Escape closes it,
 * the page behind is inert and doesn't scroll. It also closes on a tap outside and whenever the
 * page changes. Holds the patient search (hidden in the top bar on phones) and the area switch.
 */
export function MobileDrawer({ title, subtitle, searchHref, switchLink, children }: {
  title: string; subtitle?: string; searchHref?: string | null;
  switchLink?: { href: string; label: string } | null; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const path = usePathname();

  const close = () => ref.current?.close();
  useEffect(() => { close(); }, [path]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.overflow = open ? "hidden" : "";
    return () => { root.style.overflow = ""; };
  }, [open]);

  return (
    <>
      <button type="button" aria-label="Open menu" aria-expanded={open} aria-controls="mobile-drawer"
        onClick={() => { ref.current?.showModal(); setOpen(true); }}
        className="grid size-11 place-items-center rounded-control text-ink-soft hover:bg-sunken lg:hidden">
        <Icon name="Menu" className="size-6" />
      </button>
      <dialog id="mobile-drawer" ref={ref} aria-label="Menu" onClose={() => setOpen(false)}
        // a tap on the dimmed backdrop lands on the <dialog> element itself
        onClick={(e) => { if (e.target === e.currentTarget) close(); else if ((e.target as HTMLElement).closest("a")) close(); }}
        className="drawer m-0 h-dvh max-h-none w-[min(20rem,88vw)] max-w-none border-r border-line bg-surface p-0 text-ink shadow-xl lg:hidden">
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{title}</p>
              {subtitle ? <p className="truncate text-[0.95rem] text-ink-soft">{subtitle}</p> : null}
            </div>
            <button type="button" onClick={close} aria-label="Close menu" className="grid size-11 place-items-center rounded-control text-ink-soft hover:bg-sunken">
              <Icon name="X" className="size-6" />
            </button>
          </div>
          {searchHref ? (
            <form action={searchHref} role="search" className="border-b border-line px-4 py-3">
              <label className="flex items-center gap-2 rounded-control border border-line-strong bg-canvas px-3 text-ink-soft focus-within:border-pine">
                <Icon name="Search" />
                <input type="search" name="q" minLength={1} maxLength={60} placeholder="Find a patient" aria-label="Find a patient"
                  className="min-h-11 w-full bg-transparent text-base text-ink placeholder:text-ink-faint focus:outline-none" />
              </label>
            </form>
          ) : null}
          <div className="drawer-nav min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-4">{children}</div>
          {switchLink ? (
            <div className="border-t border-line p-3">
              <Link href={switchLink.href} className="flex min-h-11 items-center justify-between rounded-control bg-pine-tint px-4 font-medium text-pine-deep">
                {switchLink.label}<Icon name="ChevronRight" />
              </Link>
            </div>
          ) : null}
        </div>
      </dialog>
    </>
  );
}
