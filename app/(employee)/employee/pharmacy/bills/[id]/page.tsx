import { notFound } from "next/navigation";
import { requireTenant, can } from "@/lib/auth/context";
import { getBill } from "@/lib/pharmacy/data";
import { BillView } from "@/components/billing/bill-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bill" };

// A bill from the pharmacy counter (the shared printable view with its corrections).
export default async function Bill({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenant({ operation: "pharmacy.counter", permission: "pharmacy_sell", next: "/employee/pharmacy" });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const b = await getBill(ctx.tenantId, id);
  if (!b) notFound();
  return <BillView b={b} back={{ href: "/employee/pharmacy?tab=bills", label: "Back to bills" }}
    canCollect canReturn={can(ctx, "sale_returns")} canVoid={can(ctx, "void_invoices")} />;
}
