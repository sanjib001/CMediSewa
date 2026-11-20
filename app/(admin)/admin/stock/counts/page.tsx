import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { getOpenCount, listItems, listStores, stockInStore } from "@/lib/inventory/data";
import { CountSheet, StartCount } from "@/components/inventory/count-sheet";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Stock count" };
export const dynamic = "force-dynamic";

const exp = (d: string | null) => (d ? new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`)) : "none");

export default async function Counts({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_stock", allowPendingTenant: true, next: "/admin/stock/counts" });
  const { stores } = await listStores(ctx.tenantId);
  const want = (await searchParams).store;
  const store = stores.find((s) => s.id === want) ?? stores.find((s) => s.kind === "pharmacy") ?? stores[0];
  if (!store) return <PageHeader title="Stock count" />;
  const [open, lots, items] = await Promise.all([getOpenCount(ctx.tenantId, store.id), stockInStore(ctx.tenantId, store.id), listItems(ctx.tenantId)]);
  const sheet = lots.map((l) => {
    const it = items.find((i) => i.id === l.item_id);
    return { batch_id: l.batch_id, item: it?.name ?? "", batch_no: l.batch_no, expiry: exp(l.expiry_date), unit: it?.units.find((u) => u.is_base)?.name ?? "", system: l.qty_on_hand };
  }).sort((a, b) => a.item.localeCompare(b.item));
  return (
    <>
      <PageHeader title={`Stock count: ${store.name}`} subtitle={<><Link href={`/admin/stock?store=${store.id}`} className="text-pine hover:underline">Stock & stores</Link> / count what&apos;s on the shelf; the differences are posted as gains or losses.</>} />
      <Panel title={open ? `${open.count_no}${open.blind ? " (blind)" : ""}` : "No count open"}>
        {open ? <CountSheet countId={open.id} blind={open.blind} lots={sheet} lines={open.lines} canPost={can(ctx, "manage_stock")} /> : <StartCount storeId={store.id} />}
      </Panel>
    </>
  );
}
