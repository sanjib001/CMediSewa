import { notFound } from "next/navigation";
import { findNavLabel } from "@/lib/nav";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { requireSuperAdmin } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function PlatformSection({ params }: { params: Promise<{ section: string[] }> }) {
  await requireSuperAdmin();
  const { section } = await params;
  const label = findNavLabel(`/superadmin/${section.join("/")}`);
  if (!label) notFound();
  return (
    <>
      <PageHeader title={label} />
      <Panel><p className="text-ink-soft">This screen is built in U2 (Super Admin), on top of backend milestone B2.</p></Panel>
    </>
  );
}
