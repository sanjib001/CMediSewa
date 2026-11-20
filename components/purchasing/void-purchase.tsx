"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { voidPurchase } from "@/app/actions/purchasing";
import { Button } from "@/components/ui/primitives";

export function VoidPurchase({ id }: { id: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-soft">Voiding takes the stock back out and reverses the accounts. It works only while nothing from this bill has been sold, moved or paid.</p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" className="w-full rounded-control border border-line-strong px-3 py-2" />
      {error ? <p role="alert" className="text-sm text-alert">{error}</p> : null}
      <Button type="button" tone="danger" disabled={pending || !reason.trim()} onClick={() => {
        if (!window.confirm("Void this bill? This can't be undone.")) return;
        start(async () => {
          const r = await voidPurchase({ id, reason });
          if (r.ok) router.refresh(); else setError(r.error);
        });
      }}>Void bill</Button>
    </div>
  );
}
