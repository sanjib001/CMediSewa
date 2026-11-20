"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { decideTransfer, dispatchTransfer, findItems, receiveTransfer, requestTransfer } from "@/app/actions/inventory";
import type { ItemRow, TransferRow } from "@/lib/inventory/data";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const small = "rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm";
const STATUS: Record<string, [string, string]> = {
  requested: ["Waiting for approval", "text-warn"], approved: ["Ready to send", "text-pine-deep"], dispatched: ["In transit", "text-marigold-ink"],
  received: ["Received", "text-ok"], rejected: ["Rejected", "text-alert"], cancelled: ["Cancelled", "text-ink-faint"],
};

export function NewTransfer({ stores }: { stores: { id: string; name: string }[] }) {
  const router = useRouter();
  const [from, setFrom] = useState(stores[0]?.id ?? "");
  const [to, setTo] = useState(stores[1]?.id ?? "");
  const [rows, setRows] = useState<{ item: ItemRow; unit_id: string; qty: string }[]>([]);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<ItemRow[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="mb-1 block text-sm font-medium">From</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)} className={cn(small, "w-full py-2")}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">To</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} className={cn(small, "w-full py-2")}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <span className="min-w-40 flex-1 text-sm font-medium">{r.item.name}</span>
          <input value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} inputMode="decimal" placeholder="Qty" aria-label="Quantity" className={cn(small, "w-20")} />
          <select value={r.unit_id} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, unit_id: e.target.value } : x)))} aria-label="Unit" className={small}>
            {r.item.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <button type="button" aria-label="Remove" className="px-2 text-ink-faint hover:text-alert" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="relative max-w-sm">
        <input value={q} placeholder="Add an item" aria-label="Add an item" className={cn(small, "w-full")} onChange={(e) => {
          setQ(e.target.value);
          if (e.target.value.trim().length >= 2) findItems(e.target.value).then(setFound); else setFound([]);
        }} />
        {found.length ? (
          <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-control border border-line bg-surface shadow-lg">
            {found.map((it) => <li key={it.id}><button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-sunken" onClick={() => {
              setRows([...rows, { item: it, unit_id: (it.units.find((u) => !u.is_base) ?? it.units[0])!.id, qty: "" }]); setQ(""); setFound([]);
            }}>{it.name}</button></li>)}
          </ul>
        ) : null}
      </div>
      {msg ? <p role={msg.ok ? "status" : "alert"} className={cn("text-sm", msg.ok ? "text-ok" : "text-alert")}>{msg.text}</p> : null}
      <Button type="button" disabled={pending || !rows.length || from === to} onClick={() => start(async () => {
        const r = await requestTransfer({ fromStoreId: from, toStoreId: to, items: rows.map((x) => ({ item_id: x.item.id, unit_id: x.unit_id, qty: x.qty })) });
        setMsg(r.ok ? { ok: true, text: "Transfer created. Send it from the list below." } : { ok: false, text: r.error });
        if (r.ok) { setRows([]); router.refresh(); }
      })}>{from === to ? "Choose two different stores" : "Create transfer"}</Button>
    </div>
  );
}

export function TransferList({ transfers, stores }: { transfers: TransferRow[]; stores: { id: string; name: string }[] }) {
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "?";
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [loss, setLoss] = useState<Record<string, { qty: string; reason: string }>>({});
  const keys = useRef<Record<string, string>>({});
  const key = (id: string, step: string) => (keys.current[`${id}:${step}`] ??= crypto.randomUUID());
  const act = (id: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => start(async () => {
    const r = await fn();
    setMsg({ ...msg, [id]: r.ok ? { ok: true, text: r.message ?? "Done." } : { ok: false, text: r.error ?? "Failed." } });
    if (r.ok) router.refresh();
  });
  if (!transfers.length) return <p className="text-ink-soft">No transfers yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {transfers.map((t) => (
        <li key={t.id} className="py-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-medium tabular-nums">{t.transfer_no}</span>
            <span>{storeName(t.from_store_id)} → {storeName(t.to_store_id)}</span>
            <span className={cn("text-sm font-medium", STATUS[t.status]?.[1])}>{STATUS[t.status]?.[0] ?? t.status}</span>
            <span className="ml-auto text-sm text-ink-faint">{new Date(t.requested_at).toLocaleDateString("en-GB")}</span>
          </div>
          <p className="text-sm text-ink-soft">{t.items.map((i) => `${i.item} ${i.qty} ${i.unit}${i.batch_no ? ` (batch ${i.batch_no})` : ""}`).join("; ")}{t.note ? `. ${t.note}` : ""}{t.decision_reason && t.status !== "approved" ? `. ${t.decision_reason}` : ""}</p>
          {t.status === "dispatched" ? (
            <div className="mt-2 space-y-1">
              {t.lines.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="flex-1">{l.item}, batch {l.batch_no}: {l.dispatched} {l.unit} sent</span>
                  <input value={loss[l.id]?.qty ?? ""} onChange={(e) => setLoss({ ...loss, [l.id]: { qty: e.target.value, reason: loss[l.id]?.reason ?? "" } })} inputMode="decimal" placeholder="Lost (0)" aria-label="Quantity lost in transit" className={cn(small, "w-20 py-1")} />
                  {Number(loss[l.id]?.qty) > 0 ? <input value={loss[l.id]?.reason ?? ""} onChange={(e) => setLoss({ ...loss, [l.id]: { qty: loss[l.id]!.qty, reason: e.target.value } })} placeholder="What happened" className={cn(small, "w-40 py-1")} /> : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {t.status === "requested" ? <>
              <Button type="button" className="min-h-8 px-3 text-sm" disabled={pending} onClick={() => act(t.id, () => decideTransfer({ id: t.id, action: "approve" }))}>Approve</Button>
              <Button type="button" tone="secondary" className="min-h-8 px-3 text-sm" disabled={pending} onClick={() => { const r = window.prompt("Reason for rejecting"); if (r) act(t.id, () => decideTransfer({ id: t.id, action: "reject", reason: r })); }}>Reject</Button>
            </> : null}
            {t.status === "approved" ? <Button type="button" className="min-h-8 px-3 text-sm" disabled={pending} onClick={() => act(t.id, () => dispatchTransfer({ id: t.id, idempotencyKey: key(t.id, "send") }))}>Send (take from {storeName(t.from_store_id)})</Button> : null}
            {t.status === "dispatched" ? <Button type="button" className="min-h-8 px-3 text-sm" disabled={pending} onClick={() => act(t.id, () => receiveTransfer({
              id: t.id, idempotencyKey: key(t.id, "receive"),
              lines: t.lines.map((l) => { const lost = Number(loss[l.id]?.qty) || 0; return { line_id: l.id, received_base_qty: l.dispatched - lost, loss_base_qty: lost, loss_reason: loss[l.id]?.reason }; }),
            }))}>Receive into {storeName(t.to_store_id)}</Button> : null}
            {["requested", "approved"].includes(t.status) ? <Button type="button" tone="quiet" className="min-h-8 px-3 text-sm" disabled={pending} onClick={() => act(t.id, () => decideTransfer({ id: t.id, action: "cancel" }))}>Cancel</Button> : null}
          </div>
          {msg[t.id] ? <p role={msg[t.id]!.ok ? "status" : "alert"} className={cn("mt-1 text-sm", msg[t.id]!.ok ? "text-ok" : "text-alert")}>{msg[t.id]!.text}</p> : null}
        </li>
      ))}
    </ul>
  );
}
