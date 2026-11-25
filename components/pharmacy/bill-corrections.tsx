"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { collectDues, postReturn, voidBill } from "@/app/actions/pharmacy";
import type { ReturnableLot } from "@/lib/pharmacy/data";
import { Button } from "@/components/ui/primitives";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2";
const CHANNELS = [["esewa", "eSewa"], ["khalti", "Khalti"], ["fonepay", "Fonepay"], ["bank_transfer", "Bank transfer"], ["card", "Card"], ["other", "Other"]] as const;

export function VoidBill({ id }: { id: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-soft">Voiding cancels the whole bill: stock goes back to its batches and what was paid is refunded the way it came in. Today&apos;s bills only.</p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. billed to the wrong customer" className={field} />
      {error ? <p role="alert" className="text-sm text-alert">{error}</p> : null}
      <Button type="button" tone="danger" disabled={pending || reason.trim().length < 3} onClick={() => {
        if (!window.confirm("Void this bill? This can't be undone.")) return;
        start(async () => { const r = await voidBill({ id, reason }); if (r.ok) router.refresh(); else setError(r.error); });
      }}>{pending ? "Voiding…" : "Void bill"}</Button>
    </div>
  );
}

export function ReturnForm({ invoiceId, lots, paid, owed, canAdvance = false }: { invoiceId: string; lots: ReturnableLot[]; paid: number; owed: number; canAdvance?: boolean }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, "sellable" | "quarantine" | "none">>(() => Object.fromEntries(lots.map((l) => [l.allocation_id, l.can_shelve ? "sellable" : "quarantine"])));
  const [settlement, setSettlement] = useState<"refund_cash" | "refund_online" | "reduce_due" | "to_advance">(owed > 0 ? "reduce_due" : "refund_cash");
  const [channel, setChannel] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ no: string; total: number } | null>(null);
  const [pending, start] = useTransition();
  const estimate = lots.reduce((s, l) => s + (Number(qty[l.allocation_id]) || 0) * l.price, 0);
  if (done) return (
    <div role="status" className="rounded-panel border border-ok/40 bg-ok/5 p-4">
      <p className="font-medium">Return {done.no} posted: {npr(done.total)} {settlement === "reduce_due" ? "taken off what the patient owes" : settlement === "to_advance" ? "put into the patient's advance" : "refunded"}.</p>
      <button type="button" className="mt-2 text-pine underline" onClick={() => router.push(`/employee/pharmacy/bills/${invoiceId}`)}>Back to the bill</button>
    </div>
  );
  return (
    <form className="space-y-5" onSubmit={(e) => {
      e.preventDefault(); setError(null);
      const lines = lots.filter((l) => Number(qty[l.allocation_id]) > 0).map((l) => ({ allocation_id: l.allocation_id, qty_base: Number(qty[l.allocation_id]), restock: restock[l.allocation_id] ?? "quarantine" }));
      if (!lines.length) { setError("Enter what is coming back."); return; }
      start(async () => {
        const r = await postReturn({ idempotencyKey: key.current, invoiceId, settlement, channel: settlement === "refund_online" ? channel : null, reason, lines });
        if (r.ok) setDone(r); else setError(r.error);
      });
    }}>
      <table className="w-full text-left text-[0.95rem]">
        <thead className="text-sm text-ink-faint"><tr><th className="py-2 font-medium">Medicine and batch</th><th className="py-2 text-right font-medium">Can return</th><th className="py-2 font-medium">Returning</th><th className="py-2 font-medium">Goes to</th></tr></thead>
        <tbody className="divide-y divide-line">{lots.map((l) => {
          const left = Math.round((l.sold - l.returned) * 1000) / 1000;
          return (
            <tr key={l.allocation_id}>
              <td className="py-2.5"><div className="font-medium">{l.item}</div><div className="text-sm text-ink-soft">Batch {l.batch_no}{l.expiry_date ? `, exp ${l.expiry_date}` : ""}, {npr(l.price)} per {l.unit}</div></td>
              <td className="py-2.5 text-right tabular-nums">{left} {l.unit}</td>
              <td className="py-2.5 pl-3"><input type="number" min={0} max={left} step="any" disabled={left <= 0} value={qty[l.allocation_id] ?? ""} onChange={(e) => setQty({ ...qty, [l.allocation_id]: e.target.value })} className={`${field} w-24`} aria-label={`Returning from ${l.batch_no}`} /></td>
              <td className="py-2.5 pl-3"><select value={restock[l.allocation_id]} onChange={(e) => setRestock({ ...restock, [l.allocation_id]: e.target.value as "sellable" })} className={field} aria-label={`Where ${l.batch_no} goes`}>
                {l.can_shelve ? <option value="sellable">Back on the shelf (sealed)</option> : null}
                <option value="quarantine">Quarantine</option><option value="none">Destroyed</option></select>
                {!l.can_shelve ? <span className="mt-1 block text-xs text-ink-faint">{l.cold ? "Cold-chain: quarantine only" : "Expired or blocked: can't be resold"}</span> : null}</td>
            </tr>);
        })}</tbody>
      </table>
      <div className="grid gap-4 sm:grid-cols-3">
        <label><span className="mb-1 block text-sm font-medium">Settle by</span>
          <select value={settlement} onChange={(e) => setSettlement(e.target.value as "refund_cash")} className={field}>
            {owed > 0 ? <option value="reduce_due">Reduce what they owe ({npr(owed)})</option> : null}
            {paid > 0 ? <><option value="refund_cash">Cash refund</option><option value="refund_online">Online refund</option></> : null}
            {paid > 0 && canAdvance ? <option value="to_advance">Into the patient&apos;s advance</option> : null}
          </select></label>
        {settlement === "refund_online" ? <label><span className="mb-1 block text-sm font-medium">Refunded by</span>
          <select required value={channel} onChange={(e) => setChannel(e.target.value)} className={field}><option value="">Choose</option>{CHANNELS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label> : null}
        <label className="sm:col-span-full"><span className="mb-1 block text-sm font-medium">Reason</span><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} className={field} placeholder="e.g. Doctor changed the medicine" /></label>
      </div>
      <p className="text-ink-soft">About {npr(estimate)} before any discount and VAT on the bill. The exact amount is worked out when you post.</p>
      {error ? <p role="alert" className="text-alert">{error}</p> : null}
      <div className="flex justify-end"><Button type="submit" disabled={pending}>{pending ? "Posting…" : "Post return"}</Button></div>
    </form>
  );
}

export function CollectDues({ patientId, owed }: { patientId: string; owed: number }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [cash, setCash] = useState(String(owed));
  const [online, setOnline] = useState("");
  const [channel, setChannel] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
      e.preventDefault(); setMsg(null);
      start(async () => {
        const r = await collectDues({ idempotencyKey: key.current, patientId, cash: Number(cash) || 0, online: Number(online) || 0, channel: Number(online) ? channel : null });
        if (r.ok) { key.current = crypto.randomUUID(); setMsg({ ok: true, text: `Receipt ${r.receipt}: ${npr(r.amount)} received.` }); router.refresh(); }
        else setMsg({ ok: false, text: r.error });
      });
    }}>
      <label><span className="block text-xs text-ink-faint">Cash</span><input type="number" min={0} step="0.01" value={cash} onChange={(e) => setCash(e.target.value)} className={`${field} w-28`} /></label>
      <label><span className="block text-xs text-ink-faint">Online</span><input type="number" min={0} step="0.01" value={online} onChange={(e) => setOnline(e.target.value)} className={`${field} w-28`} /></label>
      {Number(online) ? <select required value={channel} onChange={(e) => setChannel(e.target.value)} className={`${field} w-36`} aria-label="Paid by"><option value="">Paid by</option>{CHANNELS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select> : null}
      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Collect"}</Button>
      {msg ? <p role={msg.ok ? "status" : "alert"} className={`w-full text-sm ${msg.ok ? "text-ok" : "text-alert"}`}>{msg.text}</p> : null}
    </form>
  );
}
