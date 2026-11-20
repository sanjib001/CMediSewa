import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { getAlerts, listItems, listStores, packText, stockInStore } from "@/lib/inventory/data";
import { AlertList } from "@/components/inventory/alert-list";
import { serviceClient } from "@/lib/supabase/service";
import { OpeningStockForm } from "@/components/inventory/opening-stock-form";
import { StoreAccess } from "@/components/inventory/store-access";
import { LotActions } from "@/components/inventory/lot-actions";
import { DisposalForm } from "@/components/inventory/disposal-form";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { createStore } from "@/app/actions/inventory";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Stock & stores" };
export const dynamic = "force-dynamic";

const KIND: Record<string, string> = { pharmacy: "Pharmacy", main: "Main store", quarantine: "Quarantine", emergency: "Emergency", department: "Department", branch: "Branch" };
const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const exp = (d: string | null) => (d ? new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`)) : "no expiry");

export default async function Stock({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_stock", allowPendingTenant: true, next: "/admin/stock" });
  const { stores, access, members } = await listStores(ctx.tenantId);
  const want = (await searchParams).store;
  const store = stores.find((s) => s.id === want) ?? stores.find((s) => s.kind === "pharmacy") ?? stores[0];
  if (!store) return <PageHeader title="Stock & stores" subtitle="No stores yet." />;
  const [lots, items, { data: myAccess }, alerts] = await Promise.all([
    stockInStore(ctx.tenantId, store.id), listItems(ctx.tenantId),
    serviceClient().rpc("store_access", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_store: store.id }),
    getAlerts(ctx.tenantId, store.id),
  ]);
  const canPost = can(ctx, "manage_stock") && myAccess === "manage" && store.is_receiving;
  const quarantine = stores.find((s) => s.kind === "quarantine" && s.is_active) ?? null;
  const lotCan = {
    adjust: can(ctx, "manage_stock") && myAccess === "manage",
    block: can(ctx, "block_batches"),
    move: can(ctx, "transfer_stock") && (myAccess === "manage" || myAccess === "operate"),
  };
  const byItem = new Map<string, typeof lots>();
  for (const l of lots) byItem.set(l.item_id, [...(byItem.get(l.item_id) ?? []), l]);
  const rows = [...byItem].map(([id, ls]) => ({ item: items.find((i) => i.id === id)!, lots: ls.sort((a, b) => (a.expiry_date ?? "9").localeCompare(b.expiry_date ?? "9")) }))
    .filter((r) => r.item).sort((a, b) => a.item.name.localeCompare(b.item.name));
  const value = lots.reduce((s, l) => s + l.qty_on_hand * l.unit_cost_base, 0);
  const expired = lots.filter((l) => l.expired).length, near = lots.filter((l) => l.near_expiry).length;

  return (
    <>
      <PageHeader title="Stock & stores" subtitle={`${store.name}: ${rows.length} items, ${npr(value)} at cost${expired ? `, ${expired} expired lots` : ""}${near ? `, ${near} near expiry` : ""}.`} />
      <nav aria-label="Stores" className="mb-5 flex flex-wrap gap-2">
        {stores.map((s) => (
          <Link key={s.id} href={`/admin/stock?store=${s.id}`} className={cn("rounded-control border px-3 py-1.5 text-sm", s.id === store.id ? "border-pine bg-pine-tint font-medium text-pine-deep" : "border-line-strong")}>
            {s.name} <span className="text-ink-faint">{KIND[s.kind] ?? s.kind}</span>
          </Link>
        ))}
        <span className="mx-1 self-center text-line-strong" aria-hidden>|</span>
        <Link href="/admin/stock/transfers" className="rounded-control border border-line-strong px-3 py-1.5 text-sm">Transfers</Link>
        <Link href={`/admin/stock/counts?store=${store.id}`} className="rounded-control border border-line-strong px-3 py-1.5 text-sm">Stock count</Link>
        <Link href="/admin/stock/reorder" className="rounded-control border border-line-strong px-3 py-1.5 text-sm">Reorder</Link>
      </nav>

      <div className="space-y-6">
        {alerts.length ? (
          <Panel title="Needs attention" aside={<span className="text-sm text-ink-faint">{alerts.filter((a) => a.severity === "critical").length} urgent</span>} flush>
            <AlertList alerts={alerts} />
          </Panel>
        ) : null}
        <Panel title="On the shelf" aside={<span className="text-sm text-ink-faint">Earliest expiry first; sales take the earliest sellable lot</span>} flush>
          {rows.length === 0 ? <p className="px-5 py-4 text-ink-soft">Nothing in this store yet.{canPost ? " Enter opening stock below." : ""}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-[0.95rem]">
                <thead className="text-sm text-ink-faint"><tr>
                  <th className="px-5 py-2 font-medium">Item</th><th className="py-2 font-medium">Batch</th><th className="py-2 font-medium">Expiry</th>
                  <th className="py-2 text-right font-medium">Quantity</th><th className="py-2 text-right font-medium">MRP / {""}base</th><th className="py-2 text-right font-medium">Cost value</th><th className="px-5 py-2 text-right font-medium"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {rows.map(({ item, lots: ls }) => ls.map((l, n) => (
                    <tr key={l.batch_id} className={cn(n === 0 && "border-t border-line")}>
                      <td className="px-5 py-2 align-top">{n === 0 ? <><span className="font-medium">{item.name}</span><span className="block text-xs text-ink-faint">total {packText(ls.reduce((s, x) => s + x.qty_on_hand, 0), item.units)}</span></> : null}</td>
                      <td className="py-2 font-mono text-sm">{l.batch_no}{l.status !== "active" ? <span className="ml-1 rounded bg-alert-tint px-1 text-xs text-alert">{l.status}</span> : null}</td>
                      <td className={cn("py-2 text-sm", l.expired ? "font-semibold text-alert" : l.critical_expiry ? "text-alert" : l.near_expiry ? "text-warn" : "")}>
                        {exp(l.expiry_date)}{l.expired ? " (expired)" : l.near_expiry ? " (soon)" : ""}</td>
                      <td className="py-2 text-right text-sm">{packText(l.qty_on_hand, item.units)}</td>
                      <td className="py-2 text-right text-sm tabular-nums">{l.mrp_base !== null ? npr(l.mrp_base) : "—"}</td>
                      <td className="py-2 text-right text-sm tabular-nums">{npr(l.qty_on_hand * l.unit_cost_base)}</td>
                      <td className="px-5 py-2 align-top">
                        <LotActions storeId={store.id} quarantineId={quarantine?.id ?? null} isQuarantine={store.kind === "quarantine"} can={lotCan}
                          baseUnitId={item.units.find((u) => u.is_base)!.id} baseUnit={item.units.find((u) => u.is_base)!.name}
                          lot={{ batch_id: l.batch_id, item_id: l.item_id, batch_no: l.batch_no, qty_on_hand: l.qty_on_hand, status: l.status, expired: l.expired }} />
                      </td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {store.kind === "quarantine" && can(ctx, "dispose_stock") && myAccess === "manage" && lots.length ? (
          <Panel title="Dispose" aside={<span className="text-sm text-ink-faint">Expired, damaged or recalled stock leaving the clinic</span>}>
            <DisposalForm storeId={store.id} lots={rows.flatMap(({ item, lots: ls }) => ls.map((l) => ({
              batch_id: l.batch_id, label: `${item.name}, batch ${l.batch_no}`, qty: l.qty_on_hand, unit: item.units.find((u) => u.is_base)!.name })))} />
          </Panel>
        ) : null}

        {canPost && store.kind !== "quarantine" ? (
          <Panel title="Opening stock" aside={<span className="text-sm text-ink-faint">Day-one stock, lot by lot. Purchases come in B6.</span>}>
            {items.length === 0 ? <p className="text-ink-soft">Add your items first in <Link href="/admin/medicines" className="text-pine underline">Medicines</Link>.</p>
              : <OpeningStockForm storeId={store.id} storeName={store.name} />}
          </Panel>
        ) : null}

        {can(ctx, "manage_settings") ? (
          <Panel title="Add a store" aside={<span className="text-sm text-ink-faint">E.g. a main store that supplies the pharmacy</span>}>
            <ActionForm action={createStore} submitLabel="Add store">
              <div className="grid gap-3 sm:grid-cols-4">
                <label className="block sm:col-span-2"><span className={label}>Name</span><input name="name" required placeholder="Main store" className={field} /></label>
                <label className="block"><span className={label}>Code</span><input name="code" required maxLength={12} placeholder="MAIN" className={field} /></label>
                <label className="block"><span className={label}>Kind</span>
                  <select name="kind" className={field}><option value="main">Main store</option><option value="department">Department</option><option value="emergency">Emergency</option><option value="branch">Branch</option></select></label>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_sellable" />Sells to patients (its sales use the clinic&apos;s bill header)</label>
            </ActionForm>
          </Panel>
        ) : null}

        {can(ctx, "manage_staff") ? (
          <Panel title={`Who works in ${store.name}`} aside={<span className="text-sm text-ink-faint">Operate: sell and receive. Manage: also post stock documents.</span>}>
            <StoreAccess storeId={store.id} members={members} access={access.filter((a) => a.store_id === store.id)} />
          </Panel>
        ) : null}
      </div>
    </>
  );
}
