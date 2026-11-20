import Link from "next/link";
import { serviceClient } from "@/lib/supabase/service";
import { hmac } from "@/lib/auth/hmac";
import { CancelBooking } from "@/components/public/cancel-booking";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your booking", robots: { index: false, follow: false } };

type Status = {
  status: string; start: string; end: string; mode: string; doctor: string; name: string; reason: string | null;
  cancel_reason: string | null; cancelled_by: string | null; can_cancel: boolean; clinic: string; clinic_phone: string | null;
};
const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const STATE: Record<string, [string, string]> = {
  requested: ["Waiting for the clinic to confirm", "The time is held for you. The clinic will call or email you."],
  confirmed: ["Confirmed", "Please arrive 10 minutes early and tell the front desk your name."],
  checked_in: ["You have arrived", ""], in_consultation: ["With the doctor", ""], completed: ["Visit completed", ""],
  no_show: ["Missed", "The clinic marked this appointment as missed."],
};

// The requester's private link (D-82): status and, while allowed, cancel. Only the HMAC of the
// token is stored; the page shows just this booking.
export default async function BookingStatus({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  const ok = /^[a-z0-9-]{2,50}$/.test(slug) && /^[A-Za-z0-9_-]{30,80}$/.test(token);
  const { data } = ok ? await serviceClient().rpc("public_booking_status", { p_slug: slug, p_token_hash: hmac("booking", token) }) : { data: null };
  const b = data as Status | null;
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link href={`/c/${slug}`} className="text-sm text-ink-soft hover:underline">Back to the clinic</Link>
      {!b ? (
        <p className="mt-6 text-lg">This booking link isn&apos;t valid.</p>
      ) : (
        <div className="mt-6 rounded-panel border border-line bg-surface p-6">
          <p className="text-sm text-ink-faint">{b.clinic}</p>
          <h1 className="mt-1 text-2xl font-semibold">
            {b.status === "cancelled" ? (b.cancelled_by === "guest" ? "You cancelled this request" : b.cancelled_by === "system" ? "This request expired" : "The clinic could not confirm this request") : STATE[b.status]?.[0] ?? b.status}
          </h1>
          {b.status === "cancelled" && b.cancel_reason && b.cancelled_by === "member" ? <p className="mt-2 text-ink-soft">Message from the clinic: {b.cancel_reason}</p> : null}
          {b.status !== "cancelled" && STATE[b.status]?.[1] ? <p className="mt-2 text-ink-soft">{STATE[b.status]![1]}</p> : null}
          <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-ink-faint">Patient</dt><dd>{b.name}</dd>
            <dt className="text-ink-faint">Doctor</dt><dd>{b.doctor}</dd>
            <dt className="text-ink-faint">When</dt><dd>{when(b.start)}{b.mode === "token" ? ` (token session until ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(b.end))})` : ""}</dd>
            {b.reason ? <><dt className="text-ink-faint">Reason</dt><dd>{b.reason}</dd></> : null}
          </dl>
          {b.clinic_phone ? <p className="mt-5 text-sm text-ink-soft">Questions? Call <a className="font-medium underline" href={`tel:${b.clinic_phone.replace(/[^\d+]/g, "")}`}>{b.clinic_phone}</a>.</p> : null}
          {b.can_cancel ? <div className="mt-5 border-t border-line pt-5"><CancelBooking slug={slug} token={token} /></div> : null}
        </div>
      )}
    </main>
  );
}
