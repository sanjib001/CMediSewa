import "server-only";
import webpush from "web-push";
import type { SendResult } from "./email";

// Web push to staff devices (W-19). Payload: title, body, link only (PHI-minimal, D-10).

let ready: boolean | null = null;
function configure(): boolean {
  if (ready !== null) return ready;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subject = process.env.VAPID_SUBJECT;
  ready = Boolean(pub && priv && subject);
  if (ready) webpush.setVapidDetails(subject!, pub!, priv!);
  return ready;
}

export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: { title: string; body: string | null; link: string | null }):
  Promise<SendResult & { gone?: boolean }> {
  if (!configure()) return { result: "skipped", error: "no push keys" };
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600, timeout: 15_000 });
    return { result: "sent" };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode ?? 0;
    if (status === 404 || status === 410) return { result: "failed", error: `gone (${status})`, gone: true };
    return { result: status === 429 || status >= 500 || status === 0 ? "retry" : "failed", error: status ? `push ${status}` : "network" };
  }
}
