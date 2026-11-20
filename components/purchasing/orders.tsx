"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPurchaseOrder, endPurchaseOrder } from "@/app/actions/purchasing";
import { findItems } from "@/app/actions/inventory";
import type { ItemRow } from "@/lib/inventory/data";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const f = "w-full rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint";
const lbl = "mb-1 block text-sm font-medium";

/** New purchase order: vendor, where it's delivered, and what to order. */
export function NewOrder({ vendors, stores }: { vendors: { id: string; name: string }[]; stores: { id: string; name: string }[] }) {
  const router = useRouter();
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [expected, setExpected] = useState("");
  const [rows, setRows] = useState<{ item: ItemRow; unit_id: string; qty: string; cost: string }[]>([]);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<ItemRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block"><span className={lbl}>Vendor</span><select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={cn(f, "py-2")}>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        <label className="block"><span className={lbl}>Deliver to</span><select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={cn(f, "py-2")}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="block"><span className={lbl}>Expected by</span><input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} className={cn(f, "py-2")} /></label>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <span className="min-w-40 flex-1 text-sm font-medium">{r.item.name}</span>
          <input value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} inputMode="decimal" placeholder="Qty" aria-label="Quantity" className={cn(f, "w-20")} />
          <select value={r.unit_id} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, unit_id: e.target.value } : x)))} aria-label="Unit" className={cn(f, "w-24")}>{r.item.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <input value={r.cost} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))} inputMode="decimal" placeholder="Expected rate" aria-label="Expected rate" className={cn(f, "w-28")} />
          <button type="button" aria-label="Remove" className="px-2 text-ink-faint hover:text-alert" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="relative max-w-sm">
        <input value={q} placeholder="Add an item" aria-label="Add an item" className={f} onChange={(e) => { setQ(e.target.value); if (e.target.value.trim().length >= 2) findItems(e.target.value).then(setFound); else setFound([]); }} />
        {found.length ? <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-control border border-line bg-surface shadow-lg">
          {found.map((it) => <li key={it.id}><button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-sunken" onClick={() => {
            setRows([...rows, { item: it, unit_id: (it.units.find((u) => u.can_purchase && !u.is_base) ?? it.units[0])!.id, qty: "", cost: "" }]); setQ(""); setFound([]);
          }}>{it.name}</button></li>)}</ul> : null}
      </div>
      {error ? <p role="alert" className="text-sm text-alert">{error}</p> : null}
      <Button type="button" disabled={pending || !rows.length} onClick={() => start(async () => {
        const r = await createPurchaseOrder({ vendorId, storeId, expected, lines: rows.map((x) => ({ item_id: x.item.id, unit_id: x.unit_id, qty: x.qty, expected_unit_cost: x.cost || null })) });
        if (r.ok) router.push(`/admin/purchases/orders/${r.id}`); else setError(r.error);
      })}>Create order</Button>
    </div>
  );
}

/** Reorder page: tick suggestions and order them from one vendor (one order per store). */
export function OrderSuggestions({ vendors, suggestions }: {
  vendors: { id: string; name: string }[];
  suggestions: { key: string; store_id: string; store: string; item_id: string; item: string; units: number; unit: string; purchase_unit_id: string | null; unit_cost: number | null }[];
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const chosen = suggestions.filter((s) => picked[s.key] && s.purchase_unit_id);
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line">
        {suggestions.map((s) => (
          <li key={s.key} className="flex items-center gap-3 py-2">
            <input type="checkbox" checked={Boolean(picked[s.key])} disabled={!s.purchase_unit_id} onChange={(e) => setPicked({ ...picked, [s.key]: e.target.checked })} aria-label={`Order ${s.item}`} />
            <span className="flex-1"><span className="font-medium">{s.item}</span> <span className="text-sm text-ink-faint">{s.store}</span></span>
            <span className="text-sm">{s.units} {s.unit}</span>
          </li>
        ))}
      </ul>
      {vendors.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} aria-label="Vendor" className={cn(f, "w-auto py-2")}>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          <Button type="button" disabled={pending || !chosen.length} onClick={() => start(async () => {
            setError(null);
            const stores = [...new Set(chosen.map((c) => c.store_id))];
            let first: string | null = null;
            for (const st of stores) {
              const r = await createPurchaseOrder({ vendorId, storeId: st, lines: chosen.filter((c) => c.store_id === st).map((c) => ({ item_id: c.item_id, unit_id: c.purchase_unit_id!, qty: c.units, expected_unit_cost: c.unit_cost })) });
              if (!r.ok) { setError(r.error); return; }
              first ??= r.id;
            }
            if (first) router.push(`/admin/purchases/orders/${first}`);
          })}>{chosen.length ? `Order ${chosen.length} item${chosen.length > 1 ? "s" : ""} from this vendor` : "Tick items to order"}</Button>
        </div>
      ) : <p className="text-sm text-ink-soft">Add a vendor to order from.</p>}
      {error ? <p role="alert" className="text-sm text-alert">{error}</p> : null}
    </div>
  );
}

export function EndOrder({ id, canCancel }: { id: string; canCancel: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (action: "cancel" | "close") => start(async () => {
    const reason = action === "close" ? window.prompt("Why stop waiting for the rest? (e.g. vendor out of stock)") ?? "" : "";
    const r = await endPurchaseOrder({ id, action, reason });
    if (r.ok) router.refresh(); else setError(r.error);
  });
  return (
    <div className="flex flex-wrap gap-2">
      {canCancel ? <Button type="button" tone="secondary" disabled={pending} onClick={() => run("cancel")}>Cancel order</Button>
        : <Button type="button" tone="secondary" disabled={pending} onClick={() => run("close")}>Close (stop waiting for the rest)</Button>}
      {error ? <p role="alert" className="text-sm text-alert">{error}</p> : null}
    </div>
  );
}
