import { notFound } from "next/navigation";
import { findNavLabel } from "@/lib/nav";
import { PageHeader, Panel } from "@/components/ui/primitives";

// Every Admin menu item resolves to a real route during the outline. Each one is replaced
// by its own page in U3, at which point it drops out of this catch-all.
export default async function AdminSection({ params }: { params: Promise<{ section: string[] }> }) {
  const { section } = await params;
  const label = findNavLabel(`/admin/${section.join("/")}`);
  if (!label) notFound();
  return (
    <>
      <PageHeader title={label} />
      <Panel>
        <p className="text-ink-soft">This screen is built in U3 (Admin dashboard), on top of its backend milestone.</p>
      </Panel>
    </>
  );
}
