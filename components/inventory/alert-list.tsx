import Link from "next/link";
import type { StockAlert } from "@/lib/inventory/data";
import { cn } from "@/lib/cn";

const LABEL: Record<StockAlert["kind"], string> = {
  expired: "Expired", blocked: "Blocked / recalled", near_expiry: "Expiring soon", critical_stock: "Critically low", low_stock: "Reorder",
};
const when = (d: string | null) => (d ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`)) : "");

function detail(a: StockAlert): string {
  switch (a.kind) {
    case "expired": return `Batch ${a.batch_no}, expired ${when(a.expiry_date)}: ${a.qty} still on the shelf. Move it to quarantine.`;
    case "blocked": return `Batch ${a.batch_no}: ${a.qty} on the shelf can't be sold. Move it to quarantine.`;
    case "near_expiry": return `Batch ${a.batch_no} expires ${when(a.expiry_date)} (${a.days_left} days): ${a.qty}. Sell first or return.`;
    case "critical_stock": return `${a.qty} sellable, minimum ${a.level}.`;
    case "low_stock": return `${a.qty} sellable, reorder at ${a.level}.`;
  }
}

/** What needs a pharmacist's attention, most urgent first. */
export function AlertList({ alerts, showStore = false, limit }: { alerts: StockAlert[]; showStore?: boolean; limit?: number }) {
  const shown = limit ? alerts.slice(0, limit) : alerts;
  if (!alerts.length) return <p className="px-5 py-4 text-ink-soft">Nothing needs attention.</p>;
  return (
    <>
      <ul className="divide-y divide-line">
        {shown.map((a, i) => (
          <li key={`${a.kind}-${a.store_id}-${a.item_id}-${a.batch_no ?? ""}-${i}`} className="flex gap-4 px-5 py-3">
            <span className={cn("w-32 shrink-0 text-sm font-medium", a.severity === "critical" ? "text-alert" : "text-warn")}>{LABEL[a.kind]}</span>
            <div className="min-w-0">
              <div className="font-medium">{a.item}{showStore ? <span className="font-normal text-ink-faint">, {a.store}</span> : null}</div>
              <div className="text-sm text-ink-soft">{detail(a)}</div>
            </div>
          </li>
        ))}
      </ul>
      {limit && alerts.length > limit ? <p className="px-5 pb-4 text-sm"><Link href="/admin/stock" className="text-pine hover:underline">{alerts.length - limit} more</Link></p> : null}
    </>
  );
}
