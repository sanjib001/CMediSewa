import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { listPlans } from "@/lib/platform/admin-data";
import { CreateClinicForm } from "@/components/platform/create-clinic-form";
import { PageHeader } from "@/components/ui/primitives";

export const metadata = { title: "Add a clinic" };
export const dynamic = "force-dynamic";

// Direct clinic creation (no website application needed): the clinic, its settings, roles,
// stores, subscription and admin account are created at once (create_tenant_direct).
export default async function NewClinic() {
  await requireSuperAdmin();
  const plans = (await listPlans()).filter((p) => p.is_active);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date());
  return (
    <>
      <PageHeader title="Add a clinic" subtitle={<><Link href="/superadmin/tenants" className="text-pine hover:underline">Clinics</Link> / for a clinic you signed up yourself. Its admin gets a one-time setup link, then adds staff.</>} />
      <CreateClinicForm plans={plans.map((p) => ({ id: p.id, name: `${p.name} (Rs. ${Number(p.price_npr).toLocaleString("en-IN")} / ${p.billing_cycle_days} days)`, billing_cycle_days: p.billing_cycle_days }))} today={today} />
    </>
  );
}
