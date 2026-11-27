"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/ui/icon";

/** A navigation link that marks itself current. `exact` for index routes like /admin. */
export function NavLink({
  href, label, icon, exact, variant = "sidebar", disabled, note,
}: {
  href: string; label: string; icon: string; exact?: boolean;
  variant?: "sidebar" | "tab" | "bottom" | "top";
  disabled?: boolean; note?: string;
}) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);

  if (disabled) {
    return (
      <span className={cn(styles[variant], "cursor-not-allowed text-ink-faint")} title={note} aria-disabled="true">
        <Icon name={icon} className={variant === "bottom" ? "size-5" : "size-4"} />
        <span>{label}</span>
        {note && variant !== "bottom" ? <span className="text-xs">{note}</span> : null}
      </span>
    );
  }
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cn(styles[variant], active ? activeStyles[variant] : idle[variant])}>
      <Icon name={icon} className={variant === "bottom" ? "size-5" : "size-4"} />
      <span>{label}</span>
    </Link>
  );
}

const styles = {
  sidebar: "flex items-center gap-3 rounded-control px-3 py-2.5 text-base",
  tab: "flex items-center gap-2 rounded-control px-3.5 py-2 text-[0.95rem] font-medium",
  bottom: "flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-medium",
  top: "flex items-center gap-2 border-b-2 px-1 py-3 text-[0.95rem]",
};
const activeStyles = {
  sidebar: "bg-pine-tint font-medium text-pine-deep",
  tab: "bg-pine text-white",
  bottom: "text-pine",
  top: "border-white font-medium text-white",
};
const idle = {
  sidebar: "text-ink-soft hover:bg-sunken hover:text-ink",
  tab: "text-ink-soft hover:bg-sunken hover:text-ink",
  bottom: "text-ink-faint hover:text-ink",
  top: "border-transparent text-white/70 hover:text-white",
};
