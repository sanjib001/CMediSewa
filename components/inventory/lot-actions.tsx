"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adjustStock, moveToQuarantine, setBatchStatus } from "@/app/actions/inventory";
import { cn } from "@/lib/cn";

const small = "rounded-control border border-line-strong bg-surface px-2 py-1 text-sm";
const REASONS: [string, string, -1 | 1 | 0][] = [
  ["damaged", "Damaged", -1], ["expired", "Expired (destroyed here)", -1], ["lost", "Lost", -1], ["theft", "Theft", -1],
  ["internal_use", "Used in the clinic", -1], ["sample", "Given as sample", -1], ["correction", "Correction (+ or −)", 0],
];

/** Actions on one lot in one store: adjust, block/recall/unblock (every store), move to quarantine. */
export function LotActions({ storeId, quarantineId, isQuarantine, lot, baseUnitId, baseUnit, can }: {
  storeId: string; quarantineId: string | null; isQuarantine: boolean; baseUnitId: string; baseUnit: string;
  lot: { batch_id: string; item_id: string; batch_no: string; qty_on_hand: number; status: string; expired: boolean };
  can: { adjust: boolean; block: boolean; move: boolean };
}) {
  const router = useRouter();
  const [open, setOpen] = useState<null | "adjust" | "status" | "move">(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(crypto.randomUUID());
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => start(async () => {
    const r = await fn();
    setMsg(r.ok ? { ok: true, text: r.message ?? "Done." } : { ok: false, text: r.error ?? "Failed." });
    if (r.ok) { key.current = crypto.randomUUID(); setOpen(null); router.refresh(); }
  });
  const needsAttention = lot.expired || lot.status !== "active";

  return (
    <div className="text-right">
      <div className="flex justify-end gap-3 text-sm">
        {can.adjust ? <button type="button" className="text-pine hover:underline" onClick={() => setOpen(open === "adjust" ? null : "adjust")}>Adjust</button> : null}
        {can.block ? <button type="button" className="text-pine hover:underline" onClick={() => setOpen(open === "status" ? null : "status")}>{lot.status === "active" ? "Block" : "Unblock"}</button> : null}
        {can.move && quarantineId && !isQuarantine ? (
          <button type="button" className={cn("hover:underline", needsAttention ? "font-medium text-alert" : "text-pine")} onClick={() => setOpen(open === "move" ? null : "move")}>To quarantine</button>
        ) : null}
      </div>

      {open === "adjust" ? (
        <form className="mt-2 flex flex-wrap justify-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
          const sign = REASONS.find(([r]) => r === f.reason)?.[2] ?? -1;
          const n = Math.abs(Number(f.qty));
          const signed = sign === 0 ? (f.direction === "in" ? n : -n) : sign * n;
          run(() => adjustStock({ idempotencyKey: key.current, storeId, reason: f.reason!, note: f.note, lines: [{ batch_id: lot.batch_id, qty_base: signed }] }));
        }}>
          <select name="reason" className={small} defaultValue="damaged">{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select name="direction" className={small} defaultValue="out" aria-label="For corrections: add or remove"><option value="out">remove</option><option value="in">add</option></select>
          <input name="qty" required inputMode="decimal" placeholder={`Qty (${baseUnit})`} className={cn(small, "w-24")} />
          <input name="note" placeholder="Note" className={cn(small, "w-36")} />
          <button type="submit" disabled={pending} className="rounded-control bg-pine px-3 py-1 text-sm font-medium text-white disabled:opacity-50">Post</button>
        </form>
      ) : null}

      {open === "status" ? (
        <form className="mt-2 flex flex-wrap justify-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
          run(() => setBatchStatus({ batchId: lot.batch_id, status: (lot.status === "active" ? f.status : "active") as "blocked", reason: f.reason ?? "" }));
        }}>
          {lot.status === "active" ? (
            <select name="status" className={small} defaultValue="blocked"><option value="blocked">Block (e.g. damaged packaging)</option><option value="recalled">Recalled by DDA / company</option></select>
          ) : null}
          <input name="reason" required placeholder="Reason" className={cn(small, "w-56")} />
          <button type="submit" disabled={pending} className="rounded-control bg-pine px-3 py-1 text-sm font-medium text-white disabled:opacity-50">{lot.status === "active" ? "Block in every store" : "Unblock"}</button>
        </form>
      ) : null}

      {open === "move" ? (
        <form className="mt-2 flex flex-wrap justify-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          const q = Number(new FormData(e.currentTarget).get("qty"));
          run(() => moveToQuarantine({ fromStoreId: storeId, batchId: lot.batch_id, itemId: lot.item_id, unitId: baseUnitId, qtyBase: q, quarantineId: quarantineId! }));
        }}>
          <input name="qty" required inputMode="decimal" defaultValue={lot.qty_on_hand} aria-label={`Quantity in ${baseUnit}`} className={cn(small, "w-24")} />
          <span className="self-center text-sm text-ink-soft">{baseUnit}</span>
          <button type="submit" disabled={pending} className="rounded-control bg-alert px-3 py-1 text-sm font-medium text-white disabled:opacity-50">Move to quarantine</button>
        </form>
      ) : null}
      {msg ? <p role={msg.ok ? "status" : "alert"} className={cn("mt-1 text-sm", msg.ok ? "text-ok" : "text-alert")}>{msg.text}</p> : null}
    </div>
  );
}
