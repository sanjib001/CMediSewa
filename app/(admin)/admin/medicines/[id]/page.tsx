import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { getItem, listStores, masterLists } from "@/lib/inventory/data";
import { serviceClient } from "@/lib/supabase/service";
import { saveStoreLevels } from "@/app/actions/inventory";
import { ItemForm } from "@/components/inventory/item-form";
import { ActionForm, field } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Edit item" };
export const dynamic = "force-dynamic";

const q = (n: number | null) => (n === null ? "" : String(Number(n)));

export default async function EditItem({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_items", allowPendingTenant: true, next: `/admin/medicines/${id}` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [item, lists, st, lv] = await Promise.all([
    getItem(ctx.tenantId, id), masterLists(ctx.tenantId), listStores(ctx.tenantId),
    serviceClient().from("store_item_levels").select("store_id, min_stock_level, reorder_level, max_stock_level").eq("tenant_id", ctx.tenantId).eq("item_id", id),
  ]);
  if (!item) notFound();
  const stores = st.stores.filter((s) => s.is_active && s.kind !== "quarantine");
  const levels = new Map(((lv.data ?? []) as { store_id: string; min_stock_level: number | null; reorder_level: number | null; max_stock_level: number | null }[]).map((l) => [l.store_id, l]));
  const base = item.units.find((u) => u.is_base)?.name ?? "units";
  return (
    <>
      <PageHeader title={item.name} subtitle="Edit the item. Unit sizes are fixed once it has stock." />
      <ItemForm item={item} lists={lists} />
      {stores.length > 1 ? (
        <Panel title="Levels per store" className="mt-6">
          <p className="mb-3 text-sm text-ink-soft">
            Stores sell at different speeds, so each can have its own levels (in {base}). Leave a store blank to use the item&apos;s own levels
            {item.reorder_level !== null ? ` (reorder at ${q(item.reorder_level)})` : ""}. The stock alerts and the reorder list use these.
          </p>
          <ul className="divide-y divide-line">{stores.map((s) => {
            const l = levels.get(s.id);
            return (
              <li key={s.id} className="py-3">
                <ActionForm action={saveStoreLevels} submitLabel="Save" tone="secondary" resetOnSuccess={false}>
                  <input type="hidden" name="item_id" value={item.id} /><input type="hidden" name="store_id" value={s.id} />
                  <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_7rem_7rem_7rem]">
                    <p className="font-medium">{s.name}{l ? "" : <span className="ml-2 text-sm font-normal text-ink-faint">item levels</span>}</p>
                    <label><span className="block text-xs text-ink-faint">Minimum</span><input name="min" inputMode="decimal" defaultValue={q(l?.min_stock_level ?? null)} className={field} /></label>
                    <label><span className="block text-xs text-ink-faint">Reorder at</span><input name="reorder" inputMode="decimal" defaultValue={q(l?.reorder_level ?? null)} className={field} /></label>
                    <label><span className="block text-xs text-ink-faint">Maximum</span><input name="max" inputMode="decimal" defaultValue={q(l?.max_stock_level ?? null)} className={field} /></label>
                  </div>
                </ActionForm>
              </li>);
          })}</ul>
        </Panel>
      ) : null}
    </>
  );
}
