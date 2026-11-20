"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelMyBooking } from "@/app/actions/public-booking";

export function CancelBooking({ slug, token }: { slug: string; token: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="text-sm font-medium text-alert hover:underline">Cancel this booking</button>;
  return (
    <div className="space-y-2">
      <label className="block text-sm"><span className="mb-1 block font-medium">Reason (optional)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="w-full rounded-control border border-line-strong px-3 py-2" /></label>
      {error ? <p role="alert" className="text-sm text-alert">{error}</p> : null}
      <div className="flex gap-3">
        <button type="button" disabled={pending} onClick={() => start(async () => {
          const r = await cancelMyBooking(slug, token, reason);
          if (r.ok) router.refresh(); else setError(r.error);
        })} className="rounded-control bg-alert px-4 py-2 font-medium text-white disabled:opacity-60">{pending ? "Cancelling…" : "Yes, cancel it"}</button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-ink-soft">Keep it</button>
      </div>
    </div>
  );
}
