import "server-only";

// Patient emails (W-19). Content rule: clinic, doctor, date and time, clinic phone. Never the
// reason for the visit, a diagnosis or a medicine (D-10). Sent over Resend's HTTPS API; with
// no RESEND_API_KEY the dispatcher runs dry and marks rows "skipped".

export type EmailPayload = {
  clinic: string; clinic_phone: string | null; doctor: string; date: string; time: string; mode: "slot" | "token";
  patient_first_name: string | null; cancel_reason: string | null;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const when = (p: EmailPayload) => {
  const d = new Date(`${p.date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return p.mode === "token" ? `${d} (token session from ${p.time})` : `${d} at ${p.time}`;
};

export function renderEmail(kind: string, p: EmailPayload): { subject: string; text: string; html: string } | null {
  const hello = p.patient_first_name ? `Namaste ${p.patient_first_name},` : "Namaste,";
  const call = p.clinic_phone ? `To change anything, call ${p.clinic} on ${p.clinic_phone}.` : `To change anything, contact ${p.clinic}.`;
  let subject: string, lines: string[];
  switch (kind) {
    case "booking_confirmed":
      subject = `Appointment confirmed: ${p.clinic}`;
      lines = [hello, `Your appointment with Dr. ${p.doctor} at ${p.clinic} is confirmed for ${when(p)}.`, "Please arrive 10 minutes early and bring any earlier reports.", call];
      break;
    case "booking_reminder":
      subject = `Reminder: your appointment at ${p.clinic}`;
      lines = [hello, `This is a reminder of your appointment with Dr. ${p.doctor} at ${p.clinic} on ${when(p)}.`, call];
      break;
    case "booking_rescheduled":
      subject = `Appointment moved: ${p.clinic}`;
      lines = [hello, `Your appointment with Dr. ${p.doctor} at ${p.clinic} has been moved to ${when(p)}.`, "Please arrive 10 minutes early.", call];
      break;
    case "booking_declined":
      subject = `About your booking request at ${p.clinic}`;
      lines = [hello, `${p.clinic} couldn't confirm your request to see Dr. ${p.doctor} on ${when(p)}.${p.cancel_reason ? ` ${p.cancel_reason}.` : ""}`, "You're welcome to request another time.", call];
      break;
    case "booking_cancelled":
      subject = `Appointment cancelled: ${p.clinic}`;
      lines = [hello, `Your appointment with Dr. ${p.doctor} at ${p.clinic} on ${when(p)} has been cancelled.`, call];
      break;
    default:
      return null;
  }
  const text = `${lines.join("\n\n")}\n\n${p.clinic}\n(This message was sent by CMediSewa for the clinic. Please don't reply to it.)\n`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1d2b2a;max-width:560px">${lines.map((l) => `<p>${esc(l)}</p>`).join("")}<p style="color:#5b6b69;font-size:14px">${esc(p.clinic)}<br>This message was sent by CMediSewa for the clinic. Please don't reply to it.</p></div>`;
  return { subject, text, html };
}

export type SendResult = { result: "sent" | "skipped" | "retry" | "failed"; error?: string };

export async function sendEmail(to: string, msg: { subject: string; text: string; html: string }, fromName: string): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM;
  if (!key || !from) return { result: "skipped", error: "no mail key (dry run)" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: `${fromName.replace(/[<>"]/g, "")} <${from}>`, to: [to], subject: msg.subject, text: msg.text, html: msg.html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { result: "sent" };
    const status = res.status;
    // 4xx other than rate limiting won't get better by retrying
    return { result: status === 429 || status >= 500 ? "retry" : "failed", error: `resend ${status}` };
  } catch (e) {
    return { result: "retry", error: e instanceof Error ? e.name : "network" };
  }
}
