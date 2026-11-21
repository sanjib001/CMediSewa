import { notFound } from "next/navigation";
import { requireTenant, can } from "@/lib/auth/context";
import { getBill } from "@/lib/pharmacy/data";
import { BillView } from "@/components/billing/bill-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bill" };

// Any bill (OPD or pharmacy) from Admin → Billing, with the corrections this person may make.
export default async function AdminBill({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_billing", allowPendingTenant: true, next: `/admin/billing/${id}` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const b = await getBill(ctx.tenantId, id);
  if (!b) notFound();
  return <BillView b={b} back={{ href: "/admin/billing", label: "Back to billing" }}
    canCollect={can(ctx, "manage_billing") || can(ctx, "pharmacy_sell")} canReturn={can(ctx, "sale_returns")} canVoid={can(ctx, "void_invoices")} />;
}
