"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adjustStock } from "@/app/actions/inventory";
import type { ItemRow } from "@/lib/inventory/data";
import { ItemPicker } from "@/components/inventory/opening-stock-form";
import { Button } from "@/components/ui/primitives";

const small = "w-full rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint";

/** Found stock (D-143): stock on the shelf with no lot on file (a count surplus with a new
 *  batch, a box found in the back). It becomes a lot with its batch, expiry and prices, and
 *  the value goes in as a stock gain. Lots already on file are corrected from the lot itself. */
export function FoundStockForm({ storeId }: { storeId: string }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [item, setItem] = useState<ItemRow | null>(null);
  const [f, setF] = useState({ unit_id: "", qty: "", batch_no: "", expiry_date: "", unit_cost: "", mrp: "", sale_price: "", note: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const medicine = item?.item_type === "medicine";

  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault(); setMsg(null);
      if (!item) { setMsg({ ok: false, text: "Choose the item." }); return; }
      start(async () => {
        const r = await adjustStock({ idempotencyKey: key.current, storeId, reason: "found", note: f.note || "Found stock",
          lines: [{ item_id: item.id, unit_id: f.unit_id || item.units[0]?.id, qty: f.qty, batch_no: f.batch_no.trim().toUpperCase(), expiry_date: f.expiry_date,
            unit_cost: f.unit_cost, ...(f.mrp ? { mrp: f.mrp } : {}), ...(f.sale_price ? { sale_price: f.sale_price } : {}) }] });
        if (r.ok) { key.current = crypto.randomUUID(); setItem(null); setF({ unit_id: "", qty: "", batch_no: "", expiry_date: "", unit_cost: "", mrp: "", sale_price: "", note: "" }); setMsg({ ok: true, text: "Added to the shelf as a new lot." }); router.refresh(); }
        else setMsg({ ok: false, text: r.error });
      });
    }}>
      {item ? (
        <div className="flex items-center justify-between rounded-control border border-line px-3 py-2 text-sm"><span className="font-medium">{item.name}</span>
          <button type="button" className="text-pine" onClick={() => setItem(null)}>Change</button></div>
      ) : <ItemPicker onPick={(i) => { setItem(i); setF((x) => ({ ...x, unit_id: i.units.find((u) => u.is_base)?.id ?? i.units[0]?.id ?? "" })); }} />}
      {item ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label><span className="block text-xs text-ink-faint">Quantity</span><input required inputMode="decimal" value={f.qty} onChange={set("qty")} className={small} /></label>
          <label><span className="block text-xs text-ink-faint">Unit</span><select value={f.unit_id} onChange={set("unit_id")} className={small}>{item.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label><span className="block text-xs text-ink-faint">Batch{medicine ? "" : " (optional)"}</span><input required={medicine} value={f.batch_no} onChange={set("batch_no")} className={`${small} uppercase`} /></label>
          <label><span className="block text-xs text-ink-faint">Expiry{medicine ? "" : " (optional)"}</span><input required={medicine} type="date" value={f.expiry_date} onChange={set("expiry_date")} className={small} /></label>
          <label><span className="block text-xs text-ink-faint">Cost per unit</span><input required inputMode="decimal" value={f.unit_cost} onChange={set("unit_cost")} className={small} /></label>
          <label><span className="block text-xs text-ink-faint">MRP per unit</span><input inputMode="decimal" value={f.mrp} onChange={set("mrp")} className={small} /></label>
          <label><span className="block text-xs text-ink-faint">Sale price (default MRP)</span><input inputMode="decimal" value={f.sale_price} onChange={set("sale_price")} className={small} /></label>
          <label><span className="block text-xs text-ink-faint">Where it was found</span><input value={f.note} onChange={set("note")} maxLength={300} className={small} /></label>
        </div>
      ) : null}
      {msg ? <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-alert"}`}>{msg.text}</p> : null}
      <Button type="submit" tone="secondary" disabled={pending || !item}>{pending ? "Adding…" : "Add found stock"}</Button>
    </form>
  );
}
