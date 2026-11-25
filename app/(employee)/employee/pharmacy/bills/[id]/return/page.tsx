import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { getBill, returnableLots } from "@/lib/pharmacy/data";
import { ReturnForm } from "@/components/pharmacy/bill-corrections";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";
export const metadata = { title: "Return items" };

// A customer return against the original bill (W-25). Posting needs the password confirmed in
// the last 5 minutes; the page asks for it before it opens.
export default async function ReturnItems({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "money.correct", permission: "sale_returns", next: `/employee/pharmacy/bills/${id}/return` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const b = await getBill(ctx.tenantId, id);
  if (!b) notFound();
  const lots = b.status === "issued" ? await returnableLots(ctx.tenantId, id) : [];
  return (
    <>
      <PageHeader title="Return items" subtitle={<><Link href={`/employee/pharmacy/bills/${id}`} className="text-pine hover:underline">Bill {b.invoice_no}</Link> / {b.customer}</>} />
      <Panel title="What is coming back">
        {b.status !== "issued" ? <p className="text-ink-soft">This bill is void.</p> : lots.length === 0 ? <p className="text-ink-soft">This bill has no medicines to return.</p>
          : <ReturnForm invoiceId={id} lots={lots} paid={b.paid} owed={b.outstanding} canAdvance={!!b.patient_id} />}
      </Panel>
    </>
  );
}
