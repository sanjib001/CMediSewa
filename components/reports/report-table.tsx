import Link from "next/link";
import type { Col, Row } from "@/lib/reports/data";
import { cn } from "@/lib/cn";

const money = (v: number) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (c: Col, v: Row[string] | undefined) => {
  if (v === null || v === undefined || v === "") return "";
  if (c.kind === "money") return money(Number(v));
  if (c.kind === "qty") return Number(Number(v).toFixed(3)).toLocaleString("en-IN");
  if (c.kind === "time") return new Date(String(v)).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" });
  return String(v);
};
const numeric = (c: Col) => c.kind === "money" || c.kind === "qty";

/** A report as a plain table, with totals for money columns. */
export function ReportTable({ cols, rows, totals = true }: { cols: Col[]; rows: Row[]; totals?: boolean }) {
  if (!rows.length) return <p className="px-5 py-4 text-ink-soft">Nothing in this period.</p>;
  const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const showTotals = totals && cols.some((c) => c.kind === "money" && c.key !== "balance");
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-[0.92rem]">
        <thead className="text-sm text-ink-faint"><tr>{cols.map((c) => <th key={c.key} className={cn("px-3 py-2 font-medium first:pl-5 last:pr-5", numeric(c) && "text-right")}>{c.label}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{rows.map((r, i) => (
          <tr key={i} className={r.status === "void" ? "text-ink-faint line-through" : undefined}>{cols.map((c) => {
            const href = c.link?.(r);
            const text = fmt(c, r[c.key]);
            return <td key={c.key} className={cn("px-3 py-2 first:pl-5 last:pr-5", numeric(c) && "text-right tabular-nums", c.key === "days_left" && Number(r[c.key]) < 0 && "text-alert")}>
              {href ? <Link href={href} className="text-pine hover:underline">{text}</Link> : text}</td>;
          })}</tr>))}</tbody>
        {showTotals ? <tfoot className="border-t border-line-strong font-medium"><tr>{cols.map((c, i) => (
          <td key={c.key} className={cn("px-3 py-2 first:pl-5 last:pr-5", numeric(c) && "text-right tabular-nums")}>{i === 0 ? `${rows.length} rows` : c.kind === "money" && c.key !== "balance" ? money(sum(c.key)) : ""}</td>))}</tr></tfoot> : null}
      </table>
    </div>
  );
}
