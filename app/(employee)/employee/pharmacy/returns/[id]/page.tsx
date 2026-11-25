import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { PrintButton } from "@/components/pharmacy/print-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Return slip" };

const n2 = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
const SETTLED: Record<string, string> = { refund_cash: "Refunded in cash", refund_online: "Refunded online", reduce_due: "Taken off what is owed", to_advance: "Put into the patient's advance" };
const CH: Record<string, string> = { esewa: "eSewa", khalti: "Khalti", fonepay: "Fonepay", bank_transfer: "Bank transfer", card: "Card", other: "Other" };

// The slip for a customer return (W-25, D-141): what came back, its value and how it was
// settled, with the refund receipt number. 80 mm friendly like the other slips.
export default async function ReturnSlip({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "pharmacy.counter", permission: "view_billing", next: "/employee/pharmacy" });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const db = serviceClient();
  const { data: r } = await db.from("sale_returns").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
  if (!r) notFound();
  const [inv, lines, bp, by, pay, pat] = await Promise.all([
    db.from("invoices").select("invoice_no, customer_name").eq("id", r.invoice_id).single(),
    db.from("sale_return_lines").select("qty_base, net_amount, tax_amount, restock, item_id, batch_id").eq("return_id", id),
    db.from("billing_profiles").select("legal_name, address, pan_vat_no").eq("id", r.billing_profile_id).maybeSingle(),
    db.from("tenant_members").select("display_name").eq("id", r.created_by).maybeSingle(),
    r.payment_id ? db.from("payments").select("receipt_no").eq("id", r.payment_id).maybeSingle() : Promise.resolve({ data: null }),
    r.patient_id ? db.from("patients").select("full_name, mrn").eq("id", r.patient_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const ls = (lines.data ?? []) as { qty_base: number; net_amount: number; tax_amount: number; restock: string; item_id: string; batch_id: string }[];
  const [items, lots, units] = await Promise.all([
    db.from("inventory_items").select("id, name").in("id", ls.map((l) => l.item_id)),
    db.from("item_batches").select("id, batch_no").in("id", ls.map((l) => l.batch_id)),
    db.from("item_units").select("item_id, name").in("item_id", ls.map((l) => l.item_id)).eq("is_base", true),
  ]);
  const name = new Map(((items.data ?? []) as { id: string; name: string }[]).map((i) => [i.id, i.name]));
  const batch = new Map(((lots.data ?? []) as { id: string; batch_no: string }[]).map((b) => [b.id, b.batch_no]));
  const unit = new Map(((units.data ?? []) as { item_id: string; name: string }[]).map((u) => [u.item_id, u.name]));
  const p = pat.data as { full_name: string; mrn: string } | null;
  const clinic = bp.data as { legal_name: string; address: string | null; pan_vat_no: string | null } | null;
  return (
    <div className="mx-auto max-w-sm">
      <div className="mb-4 flex justify-between print:hidden">
        <Link href={`/employee/pharmacy/bills/${r.invoice_id}`} className="text-pine hover:underline">Back to the bill</Link>
        <PrintButton />
      </div>
      <article className="space-y-3 rounded-panel border border-line bg-surface p-5 text-sm print:border-0 print:p-0">
        <header className="text-center">
          <p className="font-semibold">{clinic?.legal_name ?? ctx.tenantName}</p>
          {clinic?.address ? <p className="text-ink-soft">{clinic.address}</p> : null}
          {clinic?.pan_vat_no ? <p className="text-ink-soft">PAN {clinic.pan_vat_no}</p> : null}
          <p className="mt-2 text-base font-semibold">{`Return ${r.return_no}`}</p>
        </header>
        <div className="flex justify-between"><span>Against bill {(inv.data as { invoice_no: string } | null)?.invoice_no}</span>
          <span>{new Date(r.created_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" })}</span></div>
        <p>{p ? <>{p.full_name} <span className="text-ink-soft">MRN {p.mrn}</span></> : (inv.data as { customer_name: string | null } | null)?.customer_name ?? "Walk-in"}</p>
        <div className="border-t border-dashed border-line-strong pt-2">
          {ls.map((l, n) => (
            <div key={n} className="flex justify-between gap-2"><span>{name.get(l.item_id)} <span className="text-ink-faint">{batch.get(l.batch_id)} × {qty(Number(l.qty_base))} {unit.get(l.item_id) ?? ""}</span></span>
              <span className="tabular-nums">{n2(Number(l.net_amount) + Number(l.tax_amount))}</span></div>))}
          {Number(r.tax_amount) ? <div className="flex justify-between text-ink-soft"><span>incl. VAT</span><span className="tabular-nums">{n2(Number(r.tax_amount))}</span></div> : null}
          <div className="flex justify-between font-semibold"><span>Total returned</span><span className="tabular-nums">Rs. {n2(Number(r.total))}</span></div>
          <div className="flex justify-between"><span>{SETTLED[r.settlement] ?? r.settlement}{r.online_channel ? ` (${CH[r.online_channel] ?? r.online_channel})` : ""}</span>
            <span>{(pay.data as { receipt_no: string } | null)?.receipt_no ?? ""}</span></div>
        </div>
        <p className="text-ink-soft">Reason: {r.reason}</p>
        <p className="text-center text-xs text-ink-faint">Processed by {(by.data as { display_name: string } | null)?.display_name ?? ""}.</p>
      </article>
    </div>
  );
}
