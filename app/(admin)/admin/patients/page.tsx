import Link from "next/link";
import { requireTenant } from "@/lib/auth/context";
import { listPatients, patientCounts } from "@/lib/patients/data";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Patients" };
export const dynamic = "force-dynamic";

const SEX: Record<string, string> = { male: "M", female: "F", other: "O" };

// Patients (U3b): search by name, phone or MRN; the newest registrations; possible duplicates
// to check. Registering is done at the desk, where the visit starts.
export default async function Patients({ searchParams }: { searchParams: Promise<{ q?: string; dup?: string }> }) {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_patients", allowPendingTenant: true, next: "/admin/patients" });
  const sp = await searchParams;
  const q = String(sp.q ?? "").slice(0, 60), flagged = sp.dup === "1";
  const [list, counts] = await Promise.all([listPatients(ctx.tenantId, q, flagged), patientCounts(ctx.tenantId)]);
  return (
    <>
      <PageHeader title="Patients" subtitle={`${counts.total.toLocaleString("en-IN")} registered.`} />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <form action="/admin/patients" className="flex flex-1 flex-wrap items-end gap-2">
          <label className="min-w-64 flex-1"><span className="block text-xs text-ink-faint">Find a patient</span>
            <input type="search" name="q" defaultValue={q} placeholder="Name, phone or MRN" className="w-full rounded-control border border-line-strong px-3 py-2" /></label>
          <button className="rounded-control border border-line-strong px-3 py-2">Search</button>
        </form>
        <Link href={flagged ? "/admin/patients" : "/admin/patients?dup=1"} className={cn("rounded-control border px-3 py-2", flagged ? "border-pine bg-pine/5 font-medium" : "border-line-strong")}>
          Possible duplicates{counts.flagged ? ` (${counts.flagged})` : ""}</Link>
      </div>
      <Panel title={flagged ? "Possible duplicates to check" : q ? `Matches for "${q}"` : "Newest registrations"} flush>
        {list.length === 0 ? <p className="px-5 py-4 text-ink-soft">{flagged ? "No possible duplicates." : q ? "No patient matches. Check the spelling, or search by phone." : "No patients yet. They're registered at the registrar desk."}</p> : (
          <table className="w-full text-left text-[0.95rem]">
            <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">MRN</th><th className="py-2 font-medium">Name</th><th className="py-2 font-medium">Age / sex</th><th className="px-5 py-2 font-medium">Phone</th></tr></thead>
            <tbody className="divide-y divide-line">{list.map((p) => (
              <tr key={p.id}>
                <td className="px-5 py-2.5 tabular-nums">{p.mrn}</td>
                <td className="py-2.5"><Link href={`/admin/patients/${p.id}`} className="font-medium text-pine hover:underline">{p.full_name}</Link>{p.possible_duplicate ? <span className="ml-2 text-xs text-warn">possible duplicate</span> : null}</td>
                <td className="py-2.5">{p.age} {SEX[p.sex] ?? ""}</td>
                <td className="px-5 py-2.5">{p.phone ?? "—"}</td>
              </tr>))}</tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
