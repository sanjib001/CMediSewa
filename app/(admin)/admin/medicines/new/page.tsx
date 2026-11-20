import { requireTenant } from "@/lib/auth/context";
import { masterLists } from "@/lib/inventory/data";
import { ItemForm } from "@/components/inventory/item-form";
import { PageHeader } from "@/components/ui/primitives";

export const metadata = { title: "Add item" };
export const dynamic = "force-dynamic";

export default async function NewItem() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_items", allowPendingTenant: true, next: "/admin/medicines/new" });
  return (
    <>
      <PageHeader title="Add item" subtitle="A medicine or anything else the clinic stocks. Batches, expiry and prices are entered when stock arrives." />
      <ItemForm item={null} lists={await masterLists(ctx.tenantId)} />
    </>
  );
}
