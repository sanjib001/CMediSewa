"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPurchaseOrder, decidePurchaseOrder, endPurchaseOrder } from "@/app/actions/purchasing";
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

export type DraftLine = {
  key: string; store_id: string; store: string; item_id: string; item: string; units: number; unit: string;
  purchase_unit_id: string | null; unit_cost: number | null; detail: string; urgent: boolean;
};

/** Reorder page (M-46): one vendor's suggestions, all ticked, quantities editable; one click
 *  creates a draft order per store, expected after the vendor's delivery time. */
export function VendorDraft({ vendorId, expected, vendors, lines, canOrder }: {
  vendorId: string | null; expected: string | null; vendors: { id: string; name: string }[]; lines: DraftLine[]; canOrder: boolean;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(lines.map((l) => [l.key, Boolean(l.purchase_unit_id)])));
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => [l.key, String(l.units)])));
  const [vendor, setVendor] = useState(vendorId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const chosen = lines.filter((l) => picked[l.key] && l.purchase_unit_id && Number(qty[l.key]) > 0);
  const cost = chosen.reduce((s, l) => s + (l.unit_cost ?? 0) * Number(qty[l.key]), 0);
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line">
        {lines.map((l) => (
          <li key={l.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            {canOrder ? <input type="checkbox" checked={Boolean(picked[l.key])} disabled={!l.purchase_unit_id} onChange={(e) => setPicked({ ...picked, [l.key]: e.target.checked })} aria-label={`Order ${l.item}`} /> : null}
            <span className="min-w-48 flex-1">
              <span className="font-medium">{l.item}</span> <span className="text-sm text-ink-faint">{l.store}</span>
              <span className={cn("block text-sm", l.urgent ? "text-alert" : "text-ink-soft")}>{l.detail}{l.urgent ? " (runs out before a delivery)" : ""}</span>
            </span>
            {canOrder ? (
              <span className="flex items-center gap-1 text-sm">
                <input value={qty[l.key]} onChange={(e) => setQty({ ...qty, [l.key]: e.target.value })} inputMode="decimal" aria-label={`Quantity of ${l.item}`} className={cn(f, "w-16 text-right")} />{l.unit}
              </span>
            ) : <span className="text-sm font-medium">{l.units} {l.unit}</span>}
            <span className="w-24 text-right text-sm tabular-nums text-ink-soft">{l.unit_cost === null ? "no cost yet" : `Rs. ${(l.unit_cost * Number(qty[l.key] || 0)).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}</span>
          </li>
        ))}
      </ul>
      {canOrder ? (vendors.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {vendorId ? null : <select value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Vendor" className={cn(f, "w-auto py-2")}>
            <option value="">Choose a vendor</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>}
          <Button type="button" disabled={pending || !chosen.length || !vendor} onClick={() => start(async () => {
            setError(null);
            const stores = [...new Set(chosen.map((c) => c.store_id))];
            let first: string | null = null;
            for (const st of stores) {
              const r = await createPurchaseOrder({ vendorId: vendor, storeId: st, expected: vendorId && expected ? expected : undefined, note: "From Reorder suggestions",
                lines: chosen.filter((c) => c.store_id === st).map((c) => ({ item_id: c.item_id, unit_id: c.purchase_unit_id!, qty: qty[c.key] ?? "", expected_unit_cost: c.unit_cost })) });
              if (!r.ok) { setError(r.error); return; }
              first ??= r.id;
            }
            router.push(stores.length > 1 ? "/admin/purchases/orders" : `/admin/purchases/orders/${first}`);
          })}>{chosen.length ? `Create order for ${chosen.length} item${chosen.length > 1 ? "s" : ""}${cost ? ` (about Rs. ${cost.toLocaleString("en-IN", { maximumFractionDigits: 0 })})` : ""}` : "Tick items to order"}</Button>
        </div>
      ) : <p className="text-sm text-ink-soft">Add a vendor to order from.</p>) : null}
      {error ? <p role="alert" className="text-sm text-alert">{error}</p> : null}
    </div>
  );
}

/** Approve or reject an order waiting above the clinic's approval limit. */
export function DecideOrder({ id }: { id: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (approve: boolean) => start(async () => {
    setError(null);
    const r = await decidePurchaseOrder({ id, approve, reason });
    if (r.ok) router.refresh(); else setError(r.error);
  });
  return (
    <div className="space-y-3">
      <label className="block max-w-md"><span className={lbl}>Reason (needed to reject)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={cn(f, "py-2")} placeholder="e.g. buy from the cheaper vendor" /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => run(true)}>Approve order</Button>
        <Button type="button" tone="secondary" disabled={pending} onClick={() => run(false)}>Reject</Button>
      </div>
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
