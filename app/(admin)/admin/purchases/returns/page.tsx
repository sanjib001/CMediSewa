import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { listReturns, listVendors } from "@/lib/purchasing/data";
import { ButtonLink, PageHeader } from "@/components/ui/primitives";

export const metadata = { title: "Purchase returns" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const HOW: Record<string, string> = { credit_note: "Credit note", cash_refund: "Cash refund", online_refund: "Online refund" };

export default async function Returns({ searchParams }: { searchParams: Promise<{ posted?: string }> }) {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_purchases", allowPendingTenant: true, next: "/admin/purchases/returns" });
  const [list, vendors] = await Promise.all([listReturns(ctx.tenantId), listVendors(ctx.tenantId)]);
  const posted = (await searchParams).posted;
  return (
    <>
      <PageHeader title="Purchase returns" subtitle={<><Link href="/admin/purchases" className="text-pine hover:underline">Purchases</Link> / stock sent back to vendors.</>}
        actions={can(ctx, "return_to_vendor") ? <ButtonLink href="/admin/purchases/returns/new">Return to a vendor</ButtonLink> : null} />
      {posted ? <p role="status" className="mb-4 rounded-control bg-ok-tint px-3 py-2 text-sm text-ok">Return posted. The vendor&apos;s account is updated.</p> : null}
      {list.length === 0 ? <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">No returns yet.</p> : (
        <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
          {list.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-4 px-5 py-3">
              <span className="font-medium tabular-nums">{r.return_no}</span>
              <Link href={`/admin/vendors/${r.vendor_id}`} className="flex-1 text-pine hover:underline">{vendors.find((v) => v.id === r.vendor_id)?.name}</Link>
              <span className="text-sm text-ink-soft">{HOW[r.settlement]}</span>
              <span className="tabular-nums">{npr(r.total)}</span>
              <span className="text-sm text-ink-faint">{r.posted_at.slice(0, 10)}</span>
            </li>))}
        </ul>
      )}
    </>
  );
}
