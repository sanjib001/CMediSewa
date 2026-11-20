"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { postPurchaseReturn } from "@/app/actions/purchasing";
import type { ReturnableLot } from "@/lib/purchasing/data";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const f = "rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink";
const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const REASONS: [string, string][] = [["expired", "Expired"], ["near_expiry", "Near expiry"], ["damaged", "Damaged"], ["wrong_item", "Wrong item"], ["recall", "Recall"], ["excess", "Excess / not needed"]];

/** Return stock to the vendor it came from: per lot, how much and why; then how it's settled. */
export function ReturnForm({ vendorId, storeId, invoiceId, lots }: { vendorId: string; storeId: string; invoiceId: string | null; lots: ReturnableLot[] }) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>(Object.fromEntries(lots.map((l) => [l.batch_id, l.status !== "active" ? "recall" : l.expiry_date && l.expiry_date <= new Date().toISOString().slice(0, 10) ? "expired" : "near_expiry"])));
  const [settlement, setSettlement] = useState<"credit_note" | "cash_refund" | "online_refund">("credit_note");
  const [channel, setChannel] = useState("bank_transfer");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(crypto.randomUUID());
  const value = lots.reduce((s, l) => s + (Number(qty[l.batch_id]) || 0) * l.cost, 0);
  if (!lots.length) return <p className="text-ink-soft">Nothing from this vendor is in this store.</p>;
  return (
    <div className="space-y-4">
      <table className="w-full text-left text-sm">
        <thead className="text-ink-faint"><tr><th className="py-2 font-medium">Item and batch</th><th className="py-2 text-right font-medium">Here</th><th className="py-2 text-right font-medium">Return</th><th className="py-2 font-medium">Why</th></tr></thead>
        <tbody className="divide-y divide-line">
          {lots.map((l) => (
            <tr key={l.batch_id}>
              <td className="py-2"><span className="font-medium">{l.item}</span> <span className="font-mono">{l.batch_no}</span> <span className="text-ink-faint">{l.expiry_date ?? ""}{l.status !== "active" ? `, ${l.status}` : ""}</span></td>
              <td className="py-2 text-right">{l.qty} {l.unit}</td>
              <td className="py-2 text-right">
                <button type="button" className="mr-2 text-xs text-pine hover:underline" onClick={() => setQty({ ...qty, [l.batch_id]: String(l.qty) })}>All</button>
                <input value={qty[l.batch_id] ?? ""} onChange={(e) => setQty({ ...qty, [l.batch_id]: e.target.value })} inputMode="decimal" placeholder="0" aria-label={`Return ${l.item} ${l.batch_no} in ${l.unit}`} className={cn(f, "w-20 text-right")} />
              </td>
              <td className="py-2"><select value={reason[l.batch_id]} onChange={(e) => setReason({ ...reason, [l.batch_id]: e.target.value })} aria-label="Reason" className={f}>{REASONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></td>
            </tr>
          ))}
        </tbody>
      </table>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">The vendor will…</legend>
        {([["credit_note", "Give a credit note (reduces what you owe; any extra stays as credit with them)"], ["cash_refund", "Refund in cash"], ["online_refund", "Refund online"]] as const).map(([v, t]) => (
          <label key={v} className="flex items-center gap-2 text-sm"><input type="radio" checked={settlement === v} onChange={() => setSettlement(v)} />{t}</label>))}
        {settlement === "online_refund" ? <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Refund via" className={f}><option value="bank_transfer">Bank transfer</option><option value="esewa">eSewa</option><option value="khalti">Khalti</option><option value="fonepay">Fonepay</option><option value="other">Other</option></select> : null}
      </fieldset>
      <p className="text-sm text-ink-soft">Value at cost about {npr(value)}, plus any VAT paid on it.</p>
      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      <Button type="button" disabled={pending || value <= 0} onClick={() => {
        if (!window.confirm("Post this return? The stock leaves the store and the vendor account is updated.")) return;
        start(async () => {
          const lines = lots.filter((l) => Number(qty[l.batch_id]) > 0).map((l) => ({ batch_id: l.batch_id, qty_base: Number(qty[l.batch_id]), reason: reason[l.batch_id] ?? "excess" }));
          const r = await postPurchaseReturn({ idempotencyKey: key.current, vendorId, storeId, invoiceId, settlement, channel, lines });
          if (r.ok) { router.push(`/admin/purchases/returns?posted=${r.id}`); router.refresh(); } else setError(r.error);
        });
      }}>Post return</Button>
    </div>
  );
}
