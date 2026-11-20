"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reverseEntry } from "@/app/actions/finance";

// Cancel an expense or other income with a reason. The original stays listed, struck through.
export function ReverseEntry({ kind, id, no }: { kind: "expense" | "other_income"; id: string; no: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="text-sm text-alert hover:underline">Cancel</button>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" aria-label={`Reason to cancel ${no}`} className="w-40 rounded-control border border-line-strong px-2 py-1 text-sm" />
      <button type="button" disabled={pending || reason.trim().length < 3} className="text-sm font-medium text-alert disabled:opacity-50" onClick={() => start(async () => {
        const r = await reverseEntry({ kind, id, reason });
        if (r.ok) { setOpen(false); router.refresh(); } else setError(r.error);
      })}>{pending ? "Cancelling…" : `Cancel ${no}`}</button>
      <button type="button" onClick={() => setOpen(false)} className="text-sm text-ink-soft">Keep</button>
      {error ? <span role="alert" className="w-full text-sm text-alert">{error}</span> : null}
    </span>
  );
}
