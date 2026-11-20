import { Placeholder } from "../../../_placeholder";

export default async function TenantSite({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <Placeholder area={`Clinic site: ${slug}`} note="Tenant website and booking arrive in Phase 1 (U7)." />;
}
