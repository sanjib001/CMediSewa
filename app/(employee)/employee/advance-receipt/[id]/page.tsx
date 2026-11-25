import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { advanceReceipt } from "@/lib/patients/advances";
import { PrintButton } from "@/components/pharmacy/print-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Advance receipt" };

const n2 = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CH: Record<string, string> = { esewa: "eSewa", khalti: "Khalti", fonepay: "Fonepay", bank_transfer: "Bank transfer", card: "Card", other: "Other" };

// The slip for an advance taken or given back (M-52), 80 mm friendly like the OPD receipt.
export default async function AdvanceReceipt({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "pharmacy.counter", permission: "view_billing", next: "/employee" });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await advanceReceipt(ctx.tenantId, id);
  if (!r) notFound();
  const amount = Math.abs(r.amount);
  return (
    <div className="mx-auto max-w-sm">
      <div className="mb-4 flex justify-between print:hidden">
        <Link href="/employee" className="text-pine hover:underline">Back</Link>
        <PrintButton />
      </div>
      <article className="space-y-3 rounded-panel border border-line bg-surface p-5 text-sm print:border-0 print:p-0">
        <header className="text-center">
          <p className="font-semibold">{r.clinic?.legal_name ?? ctx.tenantName}</p>
          {r.clinic?.address ? <p className="text-ink-soft">{r.clinic.address}</p> : null}
          {r.clinic?.pan_vat_no ? <p className="text-ink-soft">PAN {r.clinic.pan_vat_no}</p> : null}
          <p className="mt-2 text-base font-semibold">{r.kind === "deposit" ? "Advance received" : "Advance given back"}</p>
        </header>
        <div className="flex justify-between"><span>Receipt {r.no}</span><span>{new Date(r.at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" })}</span></div>
        <p>{r.patient.full_name} <span className="text-ink-soft">MRN {r.patient.mrn}</span></p>
        <div className="border-t border-dashed border-line-strong pt-2">
          {r.cash ? <div className="flex justify-between"><span>Cash</span><span className="tabular-nums">{n2(Math.abs(r.cash))}</span></div> : null}
          {r.online ? <div className="flex justify-between"><span>{CH[r.channel ?? ""] ?? "Online"}{r.reference ? ` (${r.reference})` : ""}</span><span className="tabular-nums">{n2(Math.abs(r.online))}</span></div> : null}
          <div className="flex justify-between font-semibold"><span>{r.kind === "deposit" ? "Received" : "Given back"}</span><span className="tabular-nums">Rs. {n2(amount)}</span></div>
          <div className="flex justify-between text-ink-soft"><span>Advance held now</span><span className="tabular-nums">Rs. {n2(r.heldNow)}</span></div>
        </div>
        {r.note ? <p className="text-ink-soft">{r.kind === "deposit" ? "For" : "Reason"}: {r.note}</p> : null}
        <p className="text-center text-xs text-ink-faint">
          {r.kind === "deposit" ? "Held for this patient and used against their bills. Unused money is given back on request. " : ""}Issued by {r.by}.
          {r.clinic?.receipt_footer ? ` ${r.clinic.receipt_footer}` : ""}
        </p>
      </article>
    </div>
  );
}
