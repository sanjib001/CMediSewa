"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { finishCount, recordCount, startCount } from "@/app/actions/inventory";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

type Lot = { batch_id: string; item: string; batch_no: string; expiry: string; unit: string; system: number };
type Line = { batch_id: string; counted_qty_base: number; system_qty_at_count: number; variance: number };

export function StartCount({ storeId }: { storeId: string }) {
  const router = useRouter();
  const [blind, setBlind] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
        Blind count (counters don&apos;t see the system quantity, so they count what&apos;s really there)</label>
      {error ? <p role="alert" className="text-sm text-alert">{error}</p> : null}
      <Button type="button" disabled={pending} onClick={() => start(async () => {
        const r = await startCount({ storeId, blind });
        if (r.ok) router.refresh(); else setError(r.error);
      })}>Start a stock count</Button>
    </div>
  );
}

/** Count lot by lot; each entry is saved at once with the system quantity AT THAT MOMENT, so
 *  sales during the count don't create false differences. Posting applies the differences. */
export function CountSheet({ countId, blind, lots, lines, canPost }: { countId: string; blind: boolean; lots: Lot[]; lines: Line[]; canPost: boolean }) {
  const router = useRouter();
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(lines.map((l) => [l.batch_id, String(l.counted_qty_base)])));
  const [saved, setSaved] = useState<Record<string, Line>>(Object.fromEntries(lines.map((l) => [l.batch_id, l])));
  const [err, setErr] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(crypto.randomUUID());

  const save = (lot: Lot) => {
    const raw = vals[lot.batch_id];
    if (raw === undefined || raw.trim() === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) { setErr({ ...err, [lot.batch_id]: "Enter 0 or more" }); return; }
    recordCount({ countId, batchId: lot.batch_id, countedBase: n }).then((r) => {
      if (!r.ok) { setErr({ ...err, [lot.batch_id]: r.error }); return; }
      setErr({ ...err, [lot.batch_id]: "" });
      setSaved({ ...saved, [lot.batch_id]: { batch_id: lot.batch_id, counted_qty_base: n, system_qty_at_count: lot.system, variance: n - lot.system } });
    });
  };
  const counted = Object.keys(saved).length;
  const diffs = Object.values(saved).filter((l) => l.variance !== 0);

  return (
    <div className="space-y-4">
      <table className="w-full text-left text-[0.95rem]">
        <thead className="text-sm text-ink-faint"><tr><th className="py-2 font-medium">Item and batch</th>{blind ? null : <th className="py-2 text-right font-medium">System</th>}<th className="py-2 text-right font-medium">Counted</th>{blind ? null : <th className="py-2 text-right font-medium">Difference</th>}</tr></thead>
        <tbody className="divide-y divide-line">
          {lots.map((l) => {
            const s = saved[l.batch_id];
            return (
              <tr key={l.batch_id}>
                <td className="py-2"><span className="font-medium">{l.item}</span> <span className="font-mono text-sm text-ink-soft">{l.batch_no}</span> <span className="text-sm text-ink-faint">exp {l.expiry}</span></td>
                {blind ? null : <td className="py-2 text-right tabular-nums text-ink-soft">{l.system} {l.unit}</td>}
                <td className="py-2 text-right">
                  <input value={vals[l.batch_id] ?? ""} onChange={(e) => setVals({ ...vals, [l.batch_id]: e.target.value })} onBlur={() => save(l)} inputMode="decimal"
                    aria-label={`Counted ${l.item} ${l.batch_no} in ${l.unit}`} className={cn("w-24 rounded-control border px-2 py-1 text-right", s ? "border-ok" : "border-line-strong")} />
                  <span className="ml-1 text-sm text-ink-faint">{l.unit}</span>
                  {err[l.batch_id] ? <span className="block text-xs text-alert">{err[l.batch_id]}</span> : null}
                </td>
                {blind ? null : <td className={cn("py-2 text-right tabular-nums", s && s.variance < 0 ? "text-alert" : s && s.variance > 0 ? "text-ok" : "")}>{s ? (s.variance > 0 ? `+${s.variance}` : s.variance) : ""}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-sm text-ink-soft">{counted} of {lots.length} lots counted{blind ? "" : `, ${diffs.length} with a difference`}. Lots you don&apos;t count are left as they are.</p>
      {msg ? <p role={msg.ok ? "status" : "alert"} className={cn("rounded-control px-3 py-2 text-sm", msg.ok ? "bg-ok-tint text-ok" : "bg-alert-tint text-alert")}>{msg.text}</p> : null}
      <div className="flex flex-wrap gap-2">
        {canPost ? <Button type="button" disabled={pending || counted === 0} onClick={() => {
          if (!window.confirm("Post this count? Differences go into stock and the accounts.")) return;
          start(async () => {
            const r = await finishCount({ countId, action: "post", idempotencyKey: key.current });
            setMsg(r.ok ? { ok: true, text: r.message ?? "Posted." } : { ok: false, text: r.error });
            if (r.ok) router.refresh();
          });
        }}>Post count</Button> : null}
        <Button type="button" tone="secondary" disabled={pending} onClick={() => start(async () => {
          const r = await finishCount({ countId, action: "cancel", idempotencyKey: key.current });
          if (r.ok) router.refresh(); else setMsg({ ok: false, text: r.error });
        })}>Cancel count</Button>
      </div>
    </div>
  );
}
