import Link from "next/link";
import { cn } from "@/lib/cn";
import type { QueueStatus } from "@/lib/demo";

// ── Button ────────────────────────────────────────────────────────────────────
type ButtonTone = "primary" | "secondary" | "quiet" | "danger";
const tones: Record<ButtonTone, string> = {
  primary: "bg-pine text-white hover:bg-pine-deep",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-sunken",
  quiet: "text-pine hover:bg-pine-tint",
  danger: "bg-alert text-white hover:brightness-95",
};
const base =
  "inline-flex items-center justify-center gap-2 rounded-control px-4 min-h-11 text-[0.95rem] font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none";

export function Button({
  tone = "primary", className, ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return <button className={cn(base, tones[tone], className)} {...props} />;
}

export function ButtonLink({
  tone = "primary", className, href, children,
}: { tone?: ButtonTone; className?: string; href: string; children: React.ReactNode }) {
  return <Link href={href} className={cn(base, tones[tone], className)}>{children}</Link>;
}

// ── Status chip (appointment / visit state machine colours) ───────────────────
const STATUS: Record<QueueStatus, { label: string; cls: string }> = {
  booked: { label: "Booked", cls: "bg-sunken text-ink-soft" },
  waiting: { label: "Waiting", cls: "bg-warn-tint text-warn" },
  with_doctor: { label: "With doctor", cls: "bg-pine-tint text-pine-deep" },
  done: { label: "Done", cls: "bg-ok-tint text-ok" },
  no_show: { label: "No-show", cls: "bg-alert-tint text-alert" },
};
export function StatusChip({ status }: { status: QueueStatus }) {
  const s = STATUS[status];
  return <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-sm font-medium", s.cls)}>{s.label}</span>;
}

// ── Page header ───────────────────────────────────────────────────────────────
export function PageHeader({
  title, subtitle, actions,
}: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 pb-5">
      <div className="min-w-0">
        <h1 className="text-[1.75rem] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
        {subtitle ? <p className="mt-1 text-ink-soft">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

// ── Panel: a bordered section with an optional title row ──────────────────────
export function Panel({
  title, aside, children, className, flush, titleClassName,
}: { title?: string; aside?: React.ReactNode; children: React.ReactNode; className?: string; flush?: boolean; titleClassName?: string }) {
  return (
    <section className={cn("rounded-panel border border-line bg-surface", className)}>
      {title ? (
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className={cn("font-semibold", titleClassName)}>{title}</h2>
          {aside}
        </div>
      ) : null}
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

// ── Demo notice: every Phase 1 outline screen that shows invented data says so ─
export function DemoNotice({ children }: { children?: React.ReactNode }) {
  return (
    <p className="mb-5 rounded-control border border-dashed border-line-strong bg-sunken px-4 py-2 text-sm text-ink-soft">
      {children ?? "Layout preview with demo data. Real records appear once this screen is connected to the backend."}
    </p>
  );
}

// ── Allergy banner: always red, always first on clinical and dispensing screens ─
export function AllergyBanner({ allergy }: { allergy: string | null }) {
  if (!allergy) return <p className="text-sm text-ink-faint">No known allergies recorded</p>;
  return (
    <p role="alert" className="rounded-control bg-alert-tint px-3 py-1.5 text-sm font-medium text-alert">
      Allergy: {allergy}
    </p>
  );
}
