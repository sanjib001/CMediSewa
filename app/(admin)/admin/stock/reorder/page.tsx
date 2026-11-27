import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { lastReconciliation, packText, type Unit } from "@/lib/inventory/data";
import { runReconciliation } from "@/app/actions/inventory";
import { listVendors, purchasePlan } from "@/lib/purchasing/data";
import { serviceClient } from "@/lib/supabase/service";
import { VendorDraft, type DraftLine } from "@/components/purchasing/orders";
import { ActionForm } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Reorder" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const WINDOWS = [30, 60, 90];
/** Today in Nepal plus n days (rounded up), as yyyy-mm-dd: the expected date of a draft order. */
const nepalDatePlus = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date(Date.now() + Math.ceil(n) * 86_400_000));

// What to buy (M-46, D-144): per receiving store, from how fast each item really goes (sales net
// of returns, plus what the store sends to others) and the vendor's delivery time, or because it
// is at its reorder level. Grouped by the vendor it was last bought from, one draft order each.
export default async function Reorder({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_stock", allowPendingTenant: true, next: "/admin/stock/reorder" });
  const days = WINDOWS.includes(Number((await searchParams).days)) ? Number((await searchParams).days) : 30;
  const [plan, rec, vendors] = await Promise.all([purchasePlan(ctx.tenantId, days), lastReconciliation(ctx.tenantId), listVendors(ctx.tenantId)]);
  const ids = [...new Set(plan.map((p) => p.item_id))];
  const units = ids.length
    ? ((await serviceClient().from("item_units").select("id, item_id, name, factor_to_base, is_base, can_purchase, can_sell").in("item_id", ids)).data ?? []) as (Unit & { item_id: string })[]
    : [];
  const pack = (item: string, base: number) => packText(base, units.filter((u) => u.item_id === item).map((u) => ({ ...u, factor_to_base: Number(u.factor_to_base) })));
  const active = vendors.filter((v) => v.is_active).map((v) => ({ id: v.id, name: v.name }));
  const total = plan.reduce((s, x) => s + x.est_cost, 0);

  // One group per vendor last bought from; items never bought (or from an inactive vendor) go last.
  const groups = new Map<string, { vendorId: string | null; name: string; lead: number; lines: DraftLine[] }>();
  for (const p of plan) {
    const vid = p.vendor_id && active.some((v) => v.id === p.vendor_id) ? p.vendor_id : null;
    const key = vid ?? "none";
    if (!groups.has(key)) groups.set(key, { vendorId: vid, name: vid ? p.vendor_name ?? "" : "No vendor yet", lead: p.lead_days, lines: [] });
    const why = p.reason === "level"
      ? `at its reorder level (${p.reorder_level === null ? "?" : pack(p.item_id, p.reorder_level)})`
      : `${p.per_day} a day, about ${p.days_left} days left`;
    groups.get(key)!.lines.push({
      key: `${p.store_id}:${p.item_id}`, store_id: p.store_id, store: p.store_name, item_id: p.item_id, item: p.item_name,
      units: p.suggested_units, unit: p.purchase_unit, purchase_unit_id: p.purchase_unit_id,
      unit_cost: p.last_unit_cost_base === null ? null : Math.round(p.last_unit_cost_base * p.unit_factor * 100) / 100,
      detail: `${pack(p.item_id, p.on_hand)} in stock${p.on_order > 0 ? `, ${pack(p.item_id, p.on_order)} on order` : ""}; ${why}`,
      urgent: p.days_left !== null && p.days_left < p.lead_days,
    });
  }
  const list = [...groups.values()].sort((a, b) => (a.vendorId === null ? 1 : 0) - (b.vendorId === null ? 1 : 0) || a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader title="Reorder" subtitle={<><Link href="/admin/stock" className="text-pine hover:underline">Stock & stores</Link> / what each store should order: enough for the vendor&apos;s delivery time plus the days set in Settings, from how fast it has sold, or up to the item&apos;s levels.</>} />
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-soft">Sales speed from the last</span>
          {WINDOWS.map((w) => <Link key={w} href={`/admin/stock/reorder?days=${w}`} aria-current={w === days ? "page" : undefined}
            className={`rounded-control border px-3 py-2 ${w === days ? "border-pine bg-pine text-white" : "border-line-strong hover:bg-sunken"}`}>{w} days</Link>)}
          {plan.length ? <span className="ml-auto text-ink-faint">{plan.length} item{plan.length === 1 ? "" : "s"}, about {npr(total)} at the last cost</span> : null}
        </div>

        {plan.length === 0 ? (
          <Panel title="Suggested purchases"><p className="text-ink-soft">Nothing to order. Every store has enough for its vendor&apos;s delivery time, and nothing is at its reorder level.</p></Panel>
        ) : list.map((g) => (
          <Panel key={g.vendorId ?? "none"} title={g.vendorId ? g.name : "Not bought from a vendor yet"}
            aside={<span className="text-sm text-ink-faint">{g.vendorId ? `Delivers in about ${g.lead} day${g.lead === 1 ? "" : "s"} · ` : ""}{g.lines.length} item{g.lines.length === 1 ? "" : "s"}</span>}>
            <VendorDraft vendorId={g.vendorId} expected={nepalDatePlus(g.lead)} vendors={active} lines={g.lines} canOrder={can(ctx, "manage_purchases")} />
          </Panel>
        ))}

        <Panel title="Stock ledger check" aside={<span className="text-sm text-ink-faint">Runs every night; balances are rebuilt from the ledger if they ever differ</span>}>
          <p className="mb-3 text-ink-soft">
            {rec ? <>Last checked {new Date(rec.ran_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu" })}: {rec.checked} balances, {rec.mismatches ? <span className="font-medium text-alert">{rec.mismatches} repaired</span> : "all matched"}.</> : "Not checked yet."}
          </p>
          {can(ctx, "manage_stock") ? <ActionForm action={runReconciliation} submitLabel="Check now" tone="secondary"><></></ActionForm> : null}
        </Panel>
      </div>
    </>
  );
}
