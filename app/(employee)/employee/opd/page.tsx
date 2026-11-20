import { requireTenant } from "@/lib/auth/context";
import { getToday, todayIn } from "@/lib/desk/data";
import { clinicalWrite, openChart, type Chart } from "@/lib/clinical";
import { ageText } from "@/lib/desk/data";
import { serviceClient } from "@/lib/supabase/service";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { QueueButtons } from "@/components/desk/queue-buttons";
import { AllergyPanel, ConsultationEditor, PastVisits, VitalsPanel } from "@/components/clinical/consultation";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";
export const metadata = { title: "OPD" };

const CHIP: Record<string, [string, string]> = {
  waiting: ["Waiting", "text-warn"], with_doctor: ["With you", "text-pine-deep"], awaiting_billing: ["To bill", "text-marigold-ink"],
  closed: ["Done", "text-ok"], cancelled: ["Cancelled", "text-ink-faint"],
};

// The doctor's OPD (W-13/W-14). Clinical work needs a password session (A2) and doctors also
// finish 2FA (P-11). The chart is read through open_chart (care relationship checked and the
// opening logged); the consultation is the visit's draft encounter.
export default async function OpdDesk() {
  const ctx = await requireTenant({ operation: "clinical.chart", permission: "write_consultation", next: "/employee/opd" });
  const { data: profile } = await serviceClient().from("doctor_profiles").select("room, specialty").eq("tenant_id", ctx.tenantId).eq("member_id", ctx.memberId).maybeSingle<{ room: string | null; specialty: string | null }>();
  if (!profile) {
    return (
      <>
        <PageHeader title="OPD" />
        <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">You aren&apos;t set up as an OPD doctor at this clinic. An admin adds you in Admin, Doctors &amp; schedules.</p>
      </>
    );
  }
  const { visits } = await getToday(ctx.tenantId, todayIn(), ctx.memberId);
  const current = visits.find((v) => v.status === "with_doctor") ?? null;
  const waiting = visits.filter((v) => v.status === "waiting");

  let chart: Chart | { error: string } | null = null;
  let encounterId: string | null = null;
  if (current) {
    // Opening (or reopening) the visit's draft is idempotent: one draft per visit.
    const e = await clinicalWrite<string>(ctx, "start_encounter", { p_visit: current.id }, current.patient.id);
    encounterId = e.ok ? e.data : null;
    chart = await openChart(ctx, current.patient.id);
  }
  const ok = chart && !("error" in chart) ? chart : null;
  const draft = ok?.encounters?.find((e) => e.id === encounterId) ?? null;
  const past = ok?.encounters?.filter((e) => e.id !== encounterId) ?? [];
  const renderedAt = new Date().getTime();

  return (
    <>
      <PageHeader title="OPD" subtitle={[ctx.displayName, profile.room].filter(Boolean).join(", ")}
        actions={<QueueButtons currentVisitId={current?.id ?? null} waiting={waiting.length} />} />

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Panel title="My queue today" aside={<span className="text-sm text-ink-faint">{waiting.length} waiting</span>} flush>
          {visits.length === 0 ? <p className="px-4 py-4 text-ink-soft">No patients checked in yet.</p> : (
            <ul className="divide-y divide-line">
              {visits.map((v) => (
                <li key={v.id} className={cn("flex items-center gap-3 px-4 py-3", v.status === "with_doctor" && "bg-pine-tint", ["closed", "cancelled"].includes(v.status) && "opacity-60")}>
                  <span className="inline-block min-w-9 rounded bg-marigold-tint px-2 text-center font-bold text-marigold-ink">{v.token}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{v.patient.full_name}</span>
                    <span className="block text-sm text-ink-faint">{v.patient.sex.charAt(0).toUpperCase()}, {v.patient.age}
                      {v.status === "waiting" ? `, ${Math.max(0, Math.round((renderedAt - Date.parse(v.checkedInAt)) / 60000))} min` : ""}</span>
                  </span>
                  <span className={cn("text-sm", CHIP[v.status]?.[1])}>{CHIP[v.status]?.[0]}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <section aria-label="Current patient" className="min-w-0 space-y-5">
          {!current ? (
            <div className="rounded-panel border border-dashed border-line-strong p-8 text-center text-ink-soft">
              {waiting.length ? `Token ${waiting[0]!.token} is next. Press "Call next" when you're ready.` : "Nobody is waiting. New check-ins appear here."}
            </div>
          ) : chart && "error" in chart ? (
            <p role="alert" className="rounded-panel bg-alert-tint p-5 text-alert">{chart.error}</p>
          ) : ok ? (
            <>
              <div className="rounded-panel border border-line bg-surface p-5">
                <h2 className="text-xl font-semibold">{ok.patient.full_name} <span className="font-normal text-ink-faint">{ok.patient.sex}, {ageText(ok.patient.date_of_birth, ok.patient.age_years, ok.patient.created_at)}</span></h2>
                <p className="mb-4 text-sm text-ink-faint">MRN {ok.patient.mrn}, token {current.token}{ok.patient.blood_group ? `, blood group ${ok.patient.blood_group}` : ""}</p>
                <AllergyPanel patientId={ok.patient.id} allergies={ok.allergies} canEdit />
                <div className="mt-4 border-t border-line pt-4">
                  <VitalsPanel patientId={ok.patient.id} visitId={current.id} latest={ok.vitals[0] ?? null} canEdit />
                </div>
              </div>
              {draft && draft.status === "draft" ? <ConsultationEditor key={draft.id} encounter={draft} visitId={current.id} /> : (
                <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">This consultation is finalized. Press &ldquo;Done&rdquo; to finish the visit.</p>
              )}
              <Panel title="Earlier consultations">
                <PastVisits encounters={past} />
              </Panel>
            </>
          ) : null}
        </section>
      </div>
    </>
  );
}
