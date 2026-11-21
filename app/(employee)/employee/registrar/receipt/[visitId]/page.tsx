import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { getBill } from "@/lib/pharmacy/data";
import { OpdTicket } from "@/components/ui/opd-ticket";
import { PrintButton } from "@/components/pharmacy/print-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Token and receipt" };

const n2 = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The OPD slip handed over at check-in (U4): the token, doctor and room, and, if the OPD fee
// was billed, the receipt. Narrow enough for an 80 mm receipt printer; the shell hides on print.
export default async function OpdReceipt({ params }: { params: Promise<{ visitId: string }> }) {
  const { visitId } = await params;
  const ctx = await requireTenant({ operation: "front_desk.operate", permission: "view_queue", next: "/employee/registrar" });
  if (!/^[0-9a-f-]{36}$/.test(visitId)) notFound();
  const db = serviceClient();
  const { data: v } = await db.from("visits").select("id, token_no, visit_date, checked_in_at, doctor_member_id, patient_id, status").eq("tenant_id", ctx.tenantId).eq("id", visitId).maybeSingle();
  if (!v) notFound();
  const [doc, prof, pat, inv] = await Promise.all([
    db.from("tenant_members").select("display_name").eq("id", v.doctor_member_id).single(),
    db.from("doctor_profiles").select("room").eq("tenant_id", ctx.tenantId).eq("member_id", v.doctor_member_id).maybeSingle(),
    db.from("patients").select("full_name, mrn").eq("id", v.patient_id).single(),
    db.from("invoices").select("id").eq("tenant_id", ctx.tenantId).eq("visit_id", visitId).order("issued_at").limit(1).maybeSingle(),
  ]);
  const bill = inv.data ? await getBill(ctx.tenantId, inv.data.id) : null;
  const doctor = (doc.data as { display_name: string } | null)?.display_name ?? "";
  const room = (prof.data as { room: string | null } | null)?.room ?? undefined;
  const p = pat.data as { full_name: string; mrn: string } | null;
  const time = new Date(v.checked_in_at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="mx-auto max-w-sm">
      <div className="mb-4 flex justify-between print:hidden">
        <Link href="/employee/registrar" className="text-pine hover:underline">Back to the desk</Link>
        <PrintButton />
      </div>
      <article className="space-y-4 rounded-panel border border-line bg-surface p-5 text-center print:border-0 print:p-0">
        <p className="font-semibold">{bill?.profile.name ?? ctx.tenantName}</p>
        <OpdTicket token={v.token_no} doctor={doctor} room={room} time={time} size="lg" />
        <p>{p?.full_name} <span className="text-sm text-ink-soft">MRN {p?.mrn}</span></p>
        <p className="text-sm text-ink-soft">{new Date(`${v.visit_date}T12:00:00+05:45`).toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium" })}{v.status === "cancelled" ? " (cancelled)" : ""}</p>
        {bill ? (
          <div className="border-t border-dashed border-line-strong pt-3 text-left text-sm">
            <div className="flex justify-between"><span>Bill {bill.invoice_no}</span><span>{bill.status === "void" ? "VOID" : ""}</span></div>
            {bill.lines.map((l) => <div key={l.n} className="flex justify-between"><span>{l.text}</span><span className="tabular-nums">{n2(l.total)}</span></div>)}
            {bill.discount ? <div className="flex justify-between"><span>Discount</span><span className="tabular-nums">−{n2(bill.discount)}</span></div> : null}
            {bill.tax ? <div className="flex justify-between"><span>VAT 13%</span><span className="tabular-nums">{n2(bill.tax)}</span></div> : null}
            <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular-nums">Rs. {n2(bill.total)}</span></div>
            <div className="flex justify-between"><span>Paid</span><span className="tabular-nums">{n2(bill.paid)}</span></div>
            {bill.outstanding > 0 ? <div className="flex justify-between"><span>Due</span><span className="tabular-nums">{n2(bill.outstanding)}</span></div> : null}
            <p className="mt-2 text-center text-xs text-ink-faint">{bill.profile.pan ? `PAN ${bill.profile.pan}. ` : ""}Issued by {bill.by}.</p>
          </div>
        ) : null}
      </article>
    </div>
  );
}
