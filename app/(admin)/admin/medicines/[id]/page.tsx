import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { getItem, masterLists } from "@/lib/inventory/data";
import { ItemForm } from "@/components/inventory/item-form";
import { PageHeader } from "@/components/ui/primitives";

export const metadata = { title: "Edit item" };
export const dynamic = "force-dynamic";

export default async function EditItem({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_items", allowPendingTenant: true, next: `/admin/medicines/${id}` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [item, lists] = await Promise.all([getItem(ctx.tenantId, id), masterLists(ctx.tenantId)]);
  if (!item) notFound();
  return (
    <>
      <PageHeader title={item.name} subtitle="Edit the item. Pack sizes are fixed once it has stock." />
      <ItemForm item={item} lists={lists} />
    </>
  );
}
