"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recallBatch } from "@/app/actions/inventory";
import { Button } from "@/components/ui/primitives";
import { field, label } from "@/components/platform/action-form";

/** Start a recall (M-51): the medicine, the batch number on the notice, why, the notice reference. */
export function RecallForm({ items }: { items: { id: string; name: string; batches: string[] }[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [itemId, setItemId] = useState("");
  const [batch, setBatch] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const item = items.find((i) => i.id === itemId);
  const matches = q.trim().length < 2 ? [] : items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
  const known = item ? item.batches.includes(batch.trim().toUpperCase()) : false;

  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      if (!item) { setErr("Choose the medicine."); return; }
      if (!window.confirm(`Recall ${item.name} batch ${batch.trim().toUpperCase()} in every store? It can't be sold after this.`)) return;
      start(async () => {
        const r = await recallBatch({ itemId, batchNo: batch, reason, reference });
        if (r.ok && r.id) router.push(`/admin/stock/recalls/${r.id}`); else if (!r.ok) setErr(r.error);
      });
    }}>
      {item ? (
        <div className="flex items-center justify-between rounded-control border border-line px-3 py-2">
          <span className="font-medium">{item.name}</span>
          <button type="button" className="text-sm text-pine" onClick={() => { setItemId(""); setBatch(""); }}>Change</button>
        </div>
      ) : (
        <div className="relative">
          <label className="block"><span className={label}>Medicine</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type the name" className={field} /></label>
          {matches.length ? <ul className="mt-1 divide-y divide-line rounded-control border border-line">{matches.map((i) => (
            <li key={i.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-sunken" onClick={() => { setItemId(i.id); setQ(""); }}>{i.name}
              <span className="ml-2 text-sm text-ink-faint">{i.batches.length} batch{i.batches.length === 1 ? "" : "es"}</span></button></li>))}</ul> : null}
        </div>
      )}
      <label className="block"><span className={label}>Batch number (as on the notice)</span>
        <input value={batch} onChange={(e) => setBatch(e.target.value)} required maxLength={30} list="recall-batches" className={`${field} uppercase`} placeholder="e.g. B2301" /></label>
      {item ? <datalist id="recall-batches">{item.batches.map((b) => <option key={b} value={b} />)}</datalist> : null}
      {item && batch.trim() && !known ? <p className="text-sm text-warn">No lot of {item.name} has this batch number. Check the label.</p> : null}
      <label className="block"><span className={label}>Reason</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={300} className={field} placeholder="e.g. Maker recall: failed dissolution test" /></label>
      <label className="block"><span className={label}>Notice reference (optional)</span>
        <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} className={field} placeholder="e.g. DDA notice 2083/17" /></label>
      {err ? <p role="alert" className="text-sm text-alert">{err}</p> : null}
      <Button type="submit" tone="danger" disabled={pending || !item || !batch.trim()}>{pending ? "Recalling…" : "Recall in every store"}</Button>
    </form>
  );
}
