"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { releaseHold } from "@/app/actions/pharmacy";
import { Button } from "@/components/ui/primitives";

/** M-45: give held stock back to the shelf, with the reason. */
export function ReleaseHold({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open) return <Button type="button" tone="secondary" onClick={() => setOpen(true)}>Release</Button>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus aria-label="Why release it"
        placeholder="Why? e.g. customer not coming" className="min-w-56 rounded-control border border-line-strong px-3 py-2 text-sm" />
      <Button type="button" disabled={pending} onClick={() => start(async () => {
        setError(null);
        const r = await releaseHold({ id, reason });
        if (r.ok) router.refresh(); else setError(r.error);
      })}>Back to the shelf</Button>
      <button type="button" className="text-sm text-ink-soft" onClick={() => setOpen(false)}>Cancel</button>
      {error ? <p role="alert" className="w-full text-sm text-alert">{error}</p> : null}
    </div>
  );
}
