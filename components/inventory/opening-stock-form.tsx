"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { findItems, postOpeningStock, type OpeningLine } from "@/app/actions/inventory";
import type { ItemRow } from "@/lib/inventory/data";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const small = "w-full rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint";
type Row = { item: ItemRow | null; unit_id: string; qty: string; batch_no: string; expiry_date: string; unit_cost: string; mrp: string; override_reason: string };
const blank = (): Row => ({ item: null, unit_id: "", qty: "", batch_no: "", expiry_date: "", unit_cost: "", mrp: "", override_reason: "" });

function ItemPicker({ onPick }: { onPick: (i: ItemRow) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<ItemRow[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return;
    let live = true;
    const t = setTimeout(() => findItems(q).then((r) => { if (live) setList(r); }), 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return (
    <div className="relative">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item" aria-label="Item" className={small} />
      {q.trim().length >= 2 && list.length ? (
        <ul className="absolute z-10 mt-1 max-h-60 w-72 overflow-auto rounded-control border border-line bg-surface shadow-lg">
          {list.map((i) => <li key={i.id}><button type="button" onClick={() => { onPick(i); setQ(""); setList([]); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-sunken">
            {i.name} <span className="text-ink-faint">{[i.generic, i.strength].filter(Boolean).join(" ")}</span></button></li>)}
        </ul>
      ) : null}
    </div>
  );
}

/** Opening stock (W-40): what is on the shelf on day one, lot by lot. Posted once, to the ledger
 *  and the accounts (Dr Inventory / Cr Opening balances). */
export function OpeningStockForm({ storeId, storeName }: { storeId: string; storeName: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(crypto.randomUUID());
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const total = rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.unit_cost) || 0), 0);

  return (
    <div className="space-y-3">
      <div className="hidden grid-cols-[2fr_1fr_0.8fr_1fr_1.1fr_0.9fr_0.9fr_auto] gap-2 px-1 text-xs text-ink-faint lg:grid">
        <span>Item</span><span>Unit</span><span>Qty</span><span>Batch no.</span><span>Expiry</span><span>Cost / unit</span><span>MRP / unit</span><span />
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-2 gap-2 rounded-control border border-line p-2 lg:grid-cols-[2fr_1fr_0.8fr_1fr_1.1fr_0.9fr_0.9fr_auto] lg:border-0 lg:p-0">
          <div className="col-span-2 lg:col-span-1">
            {r.item ? (
              <button type="button" onClick={() => set(i, { item: null, unit_id: "" })} className="w-full truncate rounded-control bg-sunken px-2 py-1.5 text-left text-sm" title="Change item">{r.item.name}</button>
            ) : <ItemPicker onPick={(it) => set(i, { item: it, unit_id: (it.units.find((u) => !u.is_base && u.can_purchase) ?? it.units[0])?.id ?? "" })} />}
          </div>
          <select value={r.unit_id} onChange={(e) => set(i, { unit_id: e.target.value })} aria-label="Unit" className={small} disabled={!r.item}>
            {(r.item?.units ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}{u.is_base ? "" : ` (${u.factor_to_base})`}</option>)}
          </select>
          <input value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} inputMode="decimal" placeholder="Qty" aria-label="Quantity" className={small} />
          <input value={r.batch_no} onChange={(e) => set(i, { batch_no: e.target.value.toUpperCase() })} placeholder={r.item?.item_type === "medicine" ? "Batch" : "Batch (optional)"} aria-label="Batch number" className={small} />
          <input value={r.expiry_date} onChange={(e) => set(i, { expiry_date: e.target.value })} type="date" aria-label="Expiry date" className={small} />
          <input value={r.unit_cost} onChange={(e) => set(i, { unit_cost: e.target.value })} inputMode="decimal" placeholder="Cost" aria-label="Cost per unit" className={small} />
          <input value={r.mrp} onChange={(e) => set(i, { mrp: e.target.value })} inputMode="decimal" placeholder="MRP" aria-label="MRP per unit" className={small} />
          <button type="button" aria-label="Remove line" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [blank()])} className="px-2 text-ink-faint hover:text-alert">×</button>
          {msg && !msg.ok && msg.text.includes("different expiry") && msg.text.includes(`line ${i + 1}`) ? (
            <input value={r.override_reason} onChange={(e) => set(i, { override_reason: e.target.value })} placeholder="Reason the expiry differs (e.g. label reprinted)" className={cn(small, "col-span-2 lg:col-span-8")} />
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="text-sm text-pine hover:underline" onClick={() => setRows([...rows, blank()])}>Add line</button>
        <span className="ml-auto text-sm text-ink-soft">Value at cost: Rs. {total.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
      </div>
      {msg ? <p role={msg.ok ? "status" : "alert"} className={cn("rounded-control px-3 py-2 text-sm", msg.ok ? "bg-ok-tint text-ok" : "bg-alert-tint text-alert")}>{msg.text}</p> : null}
      <Button type="button" disabled={pending || !rows.some((r) => r.item)} onClick={() => {
        if (!window.confirm(`Post this opening stock into ${storeName}? It goes into the stock ledger and the accounts and can't be edited, only corrected by an adjustment.`)) return;
        start(async () => {
          const lines: OpeningLine[] = rows.filter((r) => r.item).map((r) => ({ item_id: r.item!.id, unit_id: r.unit_id, qty: r.qty, batch_no: r.batch_no, expiry_date: r.expiry_date,
            unit_cost: r.unit_cost || "0", mrp: r.mrp, override_reason: r.override_reason }));
          const res = await postOpeningStock({ idempotencyKey: key.current, storeId, lines });
          setMsg(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
          if (res.ok) { key.current = crypto.randomUUID(); setRows([blank()]); router.refresh(); }
        });
      }}>{pending ? "Posting…" : "Post opening stock"}</Button>
    </div>
  );
}
