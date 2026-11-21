import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { batchHistory, batchInfo, seesCost, type Col } from "@/lib/reports/data";
import { ReportTable } from "@/components/reports/report-table";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Batch history" };
export const dynamic = "force-dynamic";

const KIND: Record<string, string> = {
  opening: "Opening stock", purchase: "Received on a bill", purchase_return: "Returned to vendor", sale: "Sold", sale_return: "Customer return",
  transfer_out: "Sent to another store", transfer_in: "Received from a store", adjustment_in: "Adjusted in", adjustment_out: "Adjusted out",
  count_variance: "Stock count", disposal: "Disposed",
};

// Every movement of one batch with the running balance (HRestroSewa's product history).
export default async function BatchHistory({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_stock_reports", allowPendingTenant: true, next: `/admin/reports/batch/${id}` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const b = await batchInfo(ctx.tenantId, id);
  if (!b) notFound();
  const rows = (await batchHistory(ctx.tenantId, id)).map((r) => ({ ...r, kind_label: KIND[String(r.kind)] ?? String(r.kind) }));
  const cols: Col[] = [
    { key: "occurred_at", label: "When", kind: "time" }, { key: "kind_label", label: "What", kind: "text" }, { key: "store", label: "Store", kind: "text" },
    { key: "qty", label: `Qty (${b.unit})`, kind: "qty" }, { key: "store_balance", label: "In that store", kind: "qty" }, { key: "balance", label: "All stores", kind: "qty" },
    { key: "reason", label: "Reason", kind: "text" }, { key: "by_name", label: "By", kind: "text" },
    ...(seesCost(ctx) ? [{ key: "unit_cost", label: "Cost each", kind: "money" } as Col] : []),
  ];
  return (
    <>
      <PageHeader title={`Batch ${b.batch_no}`} subtitle={<><Link href="/admin/reports?r=expiry" className="text-pine hover:underline">Reports</Link> / {b.item}{b.expiry_date ? `, expires ${b.expiry_date}` : ""}{b.vendor ? `, from ${b.vendor}` : ""}{b.status !== "active" ? ` (${b.status})` : ""}</>} />
      <Panel title="Movements" flush><ReportTable cols={cols} rows={rows} totals={false} /></Panel>
    </>
  );
}
