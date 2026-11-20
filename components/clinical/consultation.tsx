"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addAddendum, changeAllergy, finalizeConsultation, recordVitals, saveConsultation, type NoteInput } from "@/app/actions/clinical";
import type { Allergy, Encounter, Vitals } from "@/lib/clinical";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const area = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-ink placeholder:text-ink-faint";
const small = "w-full rounded-control border border-line-strong bg-surface px-2 py-1.5 text-ink placeholder:text-ink-faint";
const lbl = "mb-1 block text-sm font-medium";
const ktm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

type Item = NoteInput["rx"]["items"][number];
const blankItem = (): Item => ({ medicine_text: "", strength: "", form: "", dose: "", frequency: "", duration_days: "", quantity: "", instructions: "" });

function Msg({ m }: { m: { ok: boolean; text: string } | null }) {
  return m ? <p role={m.ok ? "status" : "alert"} className={cn("rounded-control px-3 py-2 text-sm", m.ok ? "bg-ok-tint text-ok" : "bg-alert-tint text-alert")}>{m.text}</p> : null;
}

export function AllergyPanel({ patientId, allergies, canEdit }: { patientId: string; allergies: Allergy[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (p: Parameters<typeof changeAllergy>[0], form?: HTMLFormElement) => start(async () => {
    const r = await changeAllergy(p);
    setMsg(r.ok ? null : { ok: false, text: r.error });
    if (r.ok) { form?.reset(); router.refresh(); }
  });
  return (
    <div className="space-y-2">
      {allergies.length === 0 ? <p className="text-sm text-ink-faint">No known allergies recorded.</p> : (
        <ul className="flex flex-wrap gap-2">
          {allergies.map((a) => (
            <li key={a.id} role="alert" className="flex items-center gap-2 rounded-control bg-alert-tint px-3 py-1 text-sm font-medium text-alert">
              Allergy: {a.allergen}{a.reaction ? ` (${a.reaction})` : ""}{a.severity ? `, ${a.severity}` : ""}
              {canEdit ? <button type="button" aria-label={`Remove ${a.allergen}`} disabled={pending} onClick={() => run({ patientId, allergyId: a.id, remove: true })} className="text-alert/70 hover:text-alert">×</button> : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
          run({ patientId, allergen: f.allergen, reaction: f.reaction, severity: f.severity }, e.currentTarget);
        }}>
          <input name="allergen" placeholder="Add allergy, e.g. Penicillin" className={cn(small, "w-48")} />
          <input name="reaction" placeholder="Reaction" className={cn(small, "w-32")} />
          <select name="severity" className={cn(small, "w-28")} defaultValue=""><option value="">Severity</option><option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option></select>
          <Button type="submit" tone="secondary" disabled={pending} className="min-h-9 px-3 text-sm">Add</Button>
        </form>
      ) : null}
      <Msg m={msg} />
    </div>
  );
}

export function VitalsPanel({ patientId, visitId, latest, canEdit }: { patientId: string; visitId: string | null; latest: Vitals | null; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const shown: [string, string | null][] = latest ? [
    ["BP", latest.systolic ? `${latest.systolic}/${latest.diastolic}` : null], ["Pulse", latest.pulse?.toString() ?? null],
    ["Temp", latest.temp_c ? `${latest.temp_c} °C` : null], ["SpO₂", latest.spo2 ? `${latest.spo2}%` : null],
    ["RR", latest.resp_rate?.toString() ?? null], ["Weight", latest.weight_kg ? `${latest.weight_kg} kg` : null], ["Height", latest.height_cm ? `${latest.height_cm} cm` : null],
  ] : [];
  const fields: [string, string, string][] = [["systolic", "BP sys", "120"], ["diastolic", "BP dia", "80"], ["pulse", "Pulse", "72"], ["temp_c", "Temp °C", "37.0"], ["spo2", "SpO₂ %", "98"], ["weight_kg", "Weight kg", ""]];
  return (
    <div className="space-y-3">
      {latest ? (
        <dl className="flex flex-wrap gap-x-7 gap-y-1.5 text-[0.95rem]">
          {shown.filter(([, v]) => v).map(([k, v]) => <div key={k} className="flex items-baseline gap-2"><dt className="text-sm text-ink-faint">{k}</dt><dd className="font-medium">{v}</dd></div>)}
          <div className="text-sm text-ink-faint">at {new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(latest.recorded_at))}</div>
        </dl>
      ) : <p className="text-sm text-ink-faint">No vitals recorded yet.</p>}
      {canEdit ? (
        <form className="grid grid-cols-3 gap-2 sm:grid-cols-7" onSubmit={(e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
          const form = e.currentTarget;
          start(async () => {
            const r = await recordVitals({ patientId, visitId, values });
            setMsg(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
            if (r.ok) { form.reset(); router.refresh(); }
          });
        }}>
          {fields.map(([k, l, ph]) => <label key={k} className="block"><span className="mb-0.5 block text-xs text-ink-faint">{l}</span><input name={k} inputMode="decimal" placeholder={ph} className={small} /></label>)}
          <Button type="submit" tone="secondary" disabled={pending} className="min-h-9 self-end px-3 text-sm">Record</Button>
        </form>
      ) : null}
      <Msg m={msg} />
    </div>
  );
}

export function ConsultationEditor({ encounter, visitId }: { encounter: Encounter; visitId: string }) {
  const router = useRouter();
  const [note, setNote] = useState({
    chief_complaint: encounter.chief_complaint ?? "", history: encounter.history ?? "", examination: encounter.examination ?? "",
    assessment: encounter.assessment ?? "", plan: encounter.plan ?? "", advice: encounter.advice ?? "", follow_up_on: encounter.follow_up_on ?? "",
  });
  const [dx, setDx] = useState(encounter.diagnoses.length ? encounter.diagnoses.map((d) => ({ text: d.text, icd10: d.icd10 ?? "" })) : [{ text: "", icd10: "" }]);
  const [items, setItems] = useState<Item[]>(encounter.prescription?.items.length
    ? encounter.prescription.items.map((i) => ({ ...i, strength: i.strength ?? "", form: i.form ?? "", dose: i.dose ?? "", frequency: i.frequency ?? "", route: i.route ?? "",
        duration_days: i.duration_days ?? "", quantity: i.quantity ?? "", instructions: i.instructions ?? "" }))
    : []);
  const [rxNotes, setRxNotes] = useState(encounter.prescription?.notes ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, start] = useTransition();
  const hadRx = Boolean(encounter.prescription);
  const payload = { encounterId: encounter.id, note, diagnoses: dx, rx: { items, notes: rxNotes }, hadRx };
  const touch = () => { setDirty(true); setMsg(null); };

  const setItem = (i: number, k: keyof Item, v: string) => { touch(); setItems((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x))); };
  const NOTE_FIELDS: [keyof typeof note, string, number][] = [
    ["chief_complaint", "Chief complaint", 2], ["history", "History", 3], ["examination", "Examination", 3], ["assessment", "Assessment", 2], ["plan", "Plan", 2], ["advice", "Advice for the patient", 2],
  ];

  return (
    <div className="space-y-5">
      <section className="rounded-panel border border-line bg-surface p-5">
        <h3 className="mb-3 font-semibold">Consultation</h3>
        <div className="grid gap-4 md:grid-cols-2">
          {NOTE_FIELDS.map(([k, l, rows]) => (
            <label key={k} className="block"><span className={lbl}>{l}</span>
              <textarea rows={rows} value={note[k]} onChange={(e) => { touch(); setNote({ ...note, [k]: e.target.value }); }} className={area} /></label>
          ))}
        </div>
        <fieldset className="mt-4">
          <legend className={lbl}>Diagnoses</legend>
          <div className="space-y-2">
            {dx.map((d, i) => (
              <div key={i} className="flex gap-2">
                <input value={d.text} onChange={(e) => { touch(); setDx(dx.map((x, j) => (j === i ? { ...x, text: e.target.value } : x))); }} placeholder={i === 0 ? "Main diagnosis" : "Diagnosis"} className={cn(small, "flex-1")} />
                <input value={d.icd10} onChange={(e) => { touch(); setDx(dx.map((x, j) => (j === i ? { ...x, icd10: e.target.value } : x))); }} placeholder="ICD-10" aria-label="ICD-10 code (optional)" className={cn(small, "w-24")} />
                {dx.length > 1 ? <button type="button" aria-label="Remove diagnosis" className="px-2 text-ink-faint hover:text-alert" onClick={() => { touch(); setDx(dx.filter((_, j) => j !== i)); }}>×</button> : null}
              </div>
            ))}
            <button type="button" className="text-sm text-pine hover:underline" onClick={() => setDx([...dx, { text: "", icd10: "" }])}>Add diagnosis</button>
          </div>
        </fieldset>
        <label className="mt-4 block max-w-xs"><span className={lbl}>Follow up on</span>
          <input type="date" value={note.follow_up_on} onChange={(e) => { touch(); setNote({ ...note, follow_up_on: e.target.value }); }} className={small} /></label>
      </section>

      <section className="rounded-panel border border-line bg-surface p-5">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="font-semibold">Prescription</h3>
          <span className="text-sm text-ink-faint">Issued when you finalize; the pharmacy sees it then</span>
        </div>
        <datalist id="rx-forms">{["tab", "cap", "syrup", "drops", "inj", "cream", "ointment", "inhaler", "sachet"].map((v) => <option key={v} value={v} />)}</datalist>
        <datalist id="rx-freq">{["1-0-1", "1-1-1", "1-0-0", "0-0-1", "1-1-1-1", "SOS (when needed)", "once daily", "twice daily", "every 6 hours"].map((v) => <option key={v} value={v} />)}</datalist>
        {items.length === 0 ? <p className="text-sm text-ink-faint">No medicines.</p> : (
          <div className="space-y-3">
            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 rounded-control border border-line p-3 sm:grid-cols-[2fr_1fr_1fr_1fr_1.3fr_0.8fr_0.8fr_auto]">
                <input value={it.medicine_text} onChange={(e) => setItem(i, "medicine_text", e.target.value)} placeholder="Medicine (brand or generic)" aria-label="Medicine" className={cn(small, "col-span-2 sm:col-span-1")} />
                <input value={String(it.strength ?? "")} onChange={(e) => setItem(i, "strength", e.target.value)} placeholder="500 mg" aria-label="Strength" className={small} />
                <input value={String(it.form ?? "")} onChange={(e) => setItem(i, "form", e.target.value)} list="rx-forms" placeholder="tab" aria-label="Form" className={small} />
                <input value={String(it.dose ?? "")} onChange={(e) => setItem(i, "dose", e.target.value)} placeholder="1 tab" aria-label="Dose" className={small} />
                <input value={String(it.frequency ?? "")} onChange={(e) => setItem(i, "frequency", e.target.value)} list="rx-freq" placeholder="1-0-1" aria-label="Frequency" className={small} />
                <input value={String(it.duration_days ?? "")} onChange={(e) => setItem(i, "duration_days", e.target.value)} inputMode="numeric" placeholder="Days" aria-label="Days" className={small} />
                <input value={String(it.quantity ?? "")} onChange={(e) => setItem(i, "quantity", e.target.value)} inputMode="decimal" placeholder="Qty" aria-label="Quantity" className={small} />
                <button type="button" aria-label="Remove medicine" className="px-2 text-ink-faint hover:text-alert" onClick={() => { touch(); setItems(items.filter((_, j) => j !== i)); }}>×</button>
                <input value={String(it.instructions ?? "")} onChange={(e) => setItem(i, "instructions", e.target.value)} placeholder="Instructions, e.g. after food" aria-label="Instructions" className={cn(small, "col-span-2 sm:col-span-8")} />
              </div>
            ))}
          </div>
        )}
        <button type="button" className="mt-3 text-sm text-pine hover:underline" onClick={() => { touch(); setItems([...items, blankItem()]); }}>Add medicine</button>
        <label className="mt-3 block"><span className={lbl}>Note to the pharmacy</span><input value={rxNotes} onChange={(e) => { touch(); setRxNotes(e.target.value); }} className={small} /></label>
      </section>

      <Msg m={msg} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty ? <span className="mr-auto text-sm text-warn">Unsaved changes</span> : null}
        <Button type="button" tone="secondary" disabled={pending} onClick={() => start(async () => {
          const r = await saveConsultation(payload);
          setMsg(r.ok ? { ok: true, text: "Draft saved." } : { ok: false, text: r.error });
          if (r.ok) { setDirty(false); router.refresh(); }
        })}>Save draft</Button>
        <Button type="button" disabled={pending} onClick={() => {
          if (!window.confirm(`Finalize this consultation${items.length ? " and issue the prescription" : ""}? It can't be edited afterwards, only added to.`)) return;
          start(async () => {
            const r = await finalizeConsultation({ ...payload, visitId });
            setMsg(r.ok ? { ok: true, text: r.message ?? "Finalized." } : { ok: false, text: r.error });
            if (r.ok) { setDirty(false); router.refresh(); }
          });
        }}>{pending ? "Working…" : items.length ? "Finalize, issue Rx and finish" : "Finalize and finish"}</Button>
      </div>
    </div>
  );
}

export function PastVisits({ encounters }: { encounters: Encounter[] }) {
  if (!encounters.length) return <p className="text-sm text-ink-faint">No earlier consultations at this clinic.</p>;
  return (
    <ul className="divide-y divide-line">
      {encounters.map((e) => (
        <li key={e.id} className="py-3">
          <details>
            <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3">
              <span className="font-medium">{ktm(e.started_at)}</span>
              <span className="text-sm text-ink-soft">{e.diagnoses.map((d) => d.text).join(", ") || e.chief_complaint || "No diagnosis"}</span>
              <span className="ml-auto text-sm text-ink-faint">{e.doctor}{e.status === "draft" ? ", draft" : ""}</span>
            </summary>
            <div className="mt-3 space-y-2 text-[0.95rem]">
              {([["Complaint", e.chief_complaint], ["History", e.history], ["Examination", e.examination], ["Assessment", e.assessment], ["Plan", e.plan], ["Advice", e.advice]] as const)
                .filter(([, v]) => v).map(([k, v]) => <p key={k} className="whitespace-pre-line"><span className="text-sm text-ink-faint">{k}: </span>{v}</p>)}
              {e.prescription && e.prescription.status !== "draft" ? (
                <div className="rounded-control bg-sunken px-3 py-2">
                  <p className="text-sm font-medium">{e.prescription.rx_number}{e.prescription.status === "cancelled" ? " (cancelled)" : ""}</p>
                  <ul className="text-sm">{e.prescription.items.map((i, n) => <li key={n}>{[i.medicine_text, i.strength, i.form].filter(Boolean).join(" ")}: {[i.dose, i.frequency, i.duration_days ? `${i.duration_days} days` : null].filter(Boolean).join(", ")}{i.quantity ? ` (${i.quantity})` : ""}</li>)}</ul>
                </div>
              ) : null}
              {e.addenda.map((a, n) => <p key={n} className="border-l-2 border-line-strong pl-3 text-sm"><span className="text-ink-faint">Addendum {ktm(a.at)}, {a.by}: </span>{a.body}</p>)}
              {e.mine && e.status === "finalized" ? <AddendumForm encounterId={e.id} /> : null}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

function AddendumForm({ encounterId }: { encounterId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form className="flex gap-2" onSubmit={(e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const body = String(new FormData(form).get("body") ?? "");
      start(async () => {
        const r = await addAddendum({ encounterId, body });
        setMsg(r.ok ? null : { ok: false, text: r.error });
        if (r.ok) { form.reset(); router.refresh(); }
      });
    }}>
      <input name="body" placeholder="Add an addendum (e.g. a lab result)" className={cn(small, "flex-1")} />
      <Button type="submit" tone="secondary" disabled={pending} className="min-h-9 px-3 text-sm">Add</Button>
      <Msg m={msg} />
    </form>
  );
}
