import Link from "next/link";

/** Shared frame for sign-in screens: quiet, centred, branded with the clinic when known. */
export function AuthFrame({
  brand, subtitle, children, footer,
}: { brand: React.ReactNode; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          {brand}
          {subtitle ? <p className="mt-1 text-ink-soft">{subtitle}</p> : null}
        </div>
        <div className="rounded-panel border border-line bg-surface p-6 sm:p-8">{children}</div>
        <div className="mt-6 text-center text-sm text-ink-faint">
          {footer ?? <Link href="/" className="hover:text-ink">CMediSewa</Link>}
        </div>
      </div>
    </main>
  );
}

export const authInput =
  "w-full rounded-control border border-line-strong bg-surface px-3 py-2.5 text-ink placeholder:text-ink-faint";
