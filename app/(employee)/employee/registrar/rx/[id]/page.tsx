import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { ageText } from "@/lib/desk/data";
import { PrintButton } from "@/components/pharmacy/print-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Prescription" };

type Rx = {
  error?: string; rx_number: string; issued_at: string; notes: string | null;
  clinic: { name: string; address: string | null; phone: string | null };
  doctor: { name: string; registration: string | null };
  patient: { full_name: string; mrn: string; sex: string; date_of_birth: string | null; age_years: number | null; created_at: string };
  items: { medicine_text: string; strength: string | null; form: string | null; dose: string | null; frequency: string | null; duration_days: number | null; quantity: number | null; instructions: string | null }[];
};

// A printed prescription (U4; print_prescriptions, A1). The read is audited by the database
// and carries the medicines and the doctor's advice only, never the diagnosis or notes.
export default async function PrintRx({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "front_desk.operate", permission: "print_prescriptions", next: "/employee/registrar" });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { data, error } = await serviceClient().rpc("print_prescription", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_rx: id, p_session_level: ctx.level });
  const rx = data as Rx | null;
  if (error || !rx || rx.error) notFound();
  const sex = { male: "M", female: "F", other: "O" }[rx.patient.sex] ?? "";
  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-4 flex justify-between print:hidden">
        <Link href="/employee/registrar" className="text-pine hover:underline">Back to the desk</Link>
        <PrintButton />
      </div>
      <article className="rounded-panel border border-line bg-surface p-6 print:border-0 print:p-0">
        <header className="border-b border-line pb-3 text-center">
          <h1 className="text-lg font-semibold">{rx.clinic.name}</h1>
          {rx.clinic.address ? <p className="text-sm">{rx.clinic.address}</p> : null}
          {rx.clinic.phone ? <p className="text-sm">{rx.clinic.phone}</p> : null}
        </header>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 text-sm">
          <div><strong>{rx.patient.full_name}</strong>, {ageText(rx.patient.date_of_birth, rx.patient.age_years, rx.patient.created_at)} {sex}</div>
          <div className="text-right">{rx.rx_number}</div>
          <div>MRN {rx.patient.mrn}</div>
          <div className="text-right">{new Date(rx.issued_at).toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium" })}</div>
        </dl>
        <p className="mt-4 text-2xl font-semibold" aria-hidden>℞</p>
        <ol className="mt-1 space-y-3">{rx.items.map((i, n) => (
          <li key={n} className="grid grid-cols-[1.5rem_1fr] gap-x-1">
            <span className="text-ink-soft">{n + 1}.</span>
            <div>
              <div className="font-medium">{[i.medicine_text, i.strength, i.form ? `(${i.form})` : null].filter(Boolean).join(" ")}{i.quantity ? <span className="font-normal"> × {i.quantity}</span> : null}</div>
              <div className="text-sm">{[i.dose, i.frequency, i.duration_days ? `for ${i.duration_days} days` : null].filter(Boolean).join(", ")}</div>
              {i.instructions ? <div className="text-sm text-ink-soft">{i.instructions}</div> : null}
            </div>
          </li>))}</ol>
        {rx.notes ? <p className="mt-4 border-t border-line pt-3 text-sm"><span className="font-medium">Advice:</span> {rx.notes}</p> : null}
        <footer className="mt-10 text-right text-sm">
          <div className="inline-block border-t border-ink pt-1">Dr. {rx.doctor.name}{rx.doctor.registration ? <span className="block text-xs">{rx.doctor.registration}</span> : null}</div>
        </footer>
      </article>
    </div>
  );
}
