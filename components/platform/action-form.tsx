"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

type Result = { ok: true; message?: string; link?: string } | { ok: false; error: string };

/**
 * A form posting FormData to a Server Action and showing its result in place. A returned
 * `link` (one-time invite) is shown once with a copy button. It is never stored anywhere.
 */
export function ActionForm({
  action, submitLabel, children, className, tone = "primary", resetOnSuccess = true, confirm,
}: {
  action: (fd: FormData) => Promise<Result>;
  submitLabel: string;
  children: React.ReactNode;
  className?: string;
  tone?: "primary" | "secondary" | "danger";
  resetOnSuccess?: boolean;
  confirm?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <div className={className}>
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          if (confirm && !window.confirm(confirm)) return;
          const fd = new FormData(e.currentTarget);
          setResult(null);
          setCopied(false);
          start(async () => {
            const r = await action(fd);
            setResult(r);
            if (r.ok) {
              if (resetOnSuccess) formRef.current?.reset();
              router.refresh();
            }
          });
        }}
        className="space-y-3"
      >
        {children}
        <Button type="submit" tone={tone} disabled={pending}>{pending ? "Working…" : submitLabel}</Button>
      </form>
      {result ? (
        <div role={result.ok ? "status" : "alert"} className={cn("mt-3 rounded-control px-3 py-2 text-sm", result.ok ? "bg-ok-tint text-ok" : "bg-alert-tint text-alert")}>
          {result.ok ? result.message : result.error}
          {result.ok && result.link ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-surface px-2 py-1 text-ink">{result.link}</code>
              <button type="button" className="rounded-control border border-line-strong bg-surface px-3 py-1 text-ink hover:bg-sunken"
                onClick={() => navigator.clipboard.writeText(result.link!).then(() => setCopied(true))}>
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-ink placeholder:text-ink-faint";
export const label = "mb-1 block text-sm font-medium";
