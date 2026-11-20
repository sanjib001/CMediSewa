"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { disposeStock } from "@/app/actions/inventory";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-ink";

/** Disposal from quarantine: which lots, how much, how, and who witnessed it. */
export function DisposalForm({ storeId, lots }: { storeId: string; lots: { batch_id: string; label: string; qty: number; unit: string }[] }) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(crypto.randomUUID());
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
      const lines = Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([batch_id, v]) => ({ batch_id, qty_base: Number(v) }));
      if (!lines.length) { setMsg({ ok: false, text: "Enter a quantity for at least one lot." }); return; }
      if (!window.confirm("Record this disposal? The stock leaves the books as a loss.")) return;
      start(async () => {
        const r = await disposeStock({ idempotencyKey: key.current, storeId, method: f.method!, contractor: f.contractor, witness: f.witness ?? "", note: f.note, lines });
        setMsg(r.ok ? { ok: true, text: r.message ?? "Done." } : { ok: false, text: r.error });
        if (r.ok) { key.current = crypto.randomUUID(); setQty({}); router.refresh(); }
      });
    }}>
      <ul className="divide-y divide-line">
        {lots.map((l) => (
          <li key={l.batch_id} className="flex items-center gap-3 py-2">
            <span className="flex-1 text-sm">{l.label} <span className="text-ink-faint">({l.qty} {l.unit} here)</span></span>
            <button type="button" className="text-sm text-pine hover:underline" onClick={() => setQty({ ...qty, [l.batch_id]: String(l.qty) })}>All</button>
            <input value={qty[l.batch_id] ?? ""} onChange={(e) => setQty({ ...qty, [l.batch_id]: e.target.value })} inputMode="decimal" placeholder="0" aria-label={`Dispose from ${l.label}`} className={cn(field, "w-24 py-1")} />
          </li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block"><span className="mb-1 block text-sm font-medium">Method</span>
          <select name="method" className={field}><option value="authorised_contractor">Authorised waste contractor</option><option value="incineration">Incineration</option><option value="vendor_return">Returned to vendor</option><option value="other">Other</option></select></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">Contractor / vendor</span><input name="contractor" className={field} /></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">Witness</span><input name="witness" required className={field} /></label>
      </div>
      {msg ? <p role={msg.ok ? "status" : "alert"} className={cn("rounded-control px-3 py-2 text-sm", msg.ok ? "bg-ok-tint text-ok" : "bg-alert-tint text-alert")}>{msg.text}</p> : null}
      <Button type="submit" tone="danger" disabled={pending}>{pending ? "Recording…" : "Record disposal"}</Button>
    </form>
  );
}
