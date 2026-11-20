"use server";

import { serviceClient } from "@/lib/supabase/service";
import { hmac, newToken } from "@/lib/auth/hmac";
import { clientIp } from "@/lib/auth/session";

// The clinic website's booking REQUEST (B4c, D-82). No account and no payment (D-83). The
// database decides everything: whether the clinic takes requests, which times are free,
// the limits, and holding the time. The visitor gets a private link to see the status or
// cancel; only its HMAC is stored.

const SLUG = /^[a-z0-9-]{2,50}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERRORS: [RegExp, string][] = [
  [/BOOKING_CLOSED/, "This clinic isn't taking online requests right now. Please call."],
  [/SLOT_UNAVAILABLE|SLOT_TAKEN/, "That time was just taken. Please choose another."],
  [/SESSION_FULL/, "That OPD session is full. Please choose another."],
  [/TOO_MANY_OPEN/, "You already have open requests with this clinic. Please wait for them to be confirmed, or call."],
  [/RATE_LIMITED/, "Too many requests from this connection today. Please call the clinic."],
  [/CONTACT_REQUIRED/, "Give a phone number or an email so the clinic can confirm."],
  [/NAME_REQUIRED/, "Enter the patient's name."],
  [/TOO_LATE_TO_CANCEL/, "It's too close to the time to cancel online. Please call the clinic."],
  [/BOOKING_NOT_FOUND/, "This link isn't valid."],
  [/requester_phone_check/, "Enter a valid phone number."],
  [/requester_email_check/, "Enter a valid email address."],
];
const friendly = (e: { message?: string } | null) => ERRORS.find(([re]) => re.test(e?.message ?? ""))?.[1] ?? "Something went wrong. Please try again or call the clinic.";

export type PublicSlot = { start: string; end: string; mode: "slot" | "token"; left: number };

export async function listPublicSlots(slug: string, doctorId: string, date: string): Promise<PublicSlot[]> {
  if (!SLUG.test(slug) || !UUID.test(doctorId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const { data, error } = await serviceClient().rpc("public_booking_slots", { p_slug: slug, p_doctor: doctorId, p_date: date });
  if (error) return [];
  return ((data ?? []) as { slot_start: string; slot_end: string; mode: "slot" | "token"; places_left: number }[])
    .map((s) => ({ start: new Date(s.slot_start).toISOString(), end: new Date(s.slot_end).toISOString(), mode: s.mode, left: s.places_left }));
}

export type RequestInput = {
  slug: string; doctorId: string; start: string; name: string; phone?: string; email?: string; age?: string; sex?: string; reason?: string;
  consent?: boolean; website?: string; // `website` is a honeypot: people never fill it
};
export async function requestBooking(input: RequestInput): Promise<{ ok: true; link: string } | { ok: false; error: string }> {
  if (!SLUG.test(input.slug) || !UUID.test(input.doctorId) || Number.isNaN(Date.parse(input.start))) return { ok: false, error: "Choose a doctor and a time." };
  if (!input.consent) return { ok: false, error: "Please agree that the clinic may contact you about this request." };
  const token = newToken();
  if (input.website) return { ok: true, link: `/c/${input.slug}/booking/${token}` }; // bot: looks fine, nothing stored
  const age = String(input.age ?? "").trim() === "" ? null : Number(input.age);
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 130)) return { ok: false, error: "Enter the age in years." };
  const { error } = await serviceClient().rpc("request_booking", {
    p_slug: input.slug, p_doctor: input.doctorId, p_start: input.start, p_name: String(input.name ?? "").trim().slice(0, 120),
    p_phone: String(input.phone ?? "").trim().slice(0, 20), p_email: String(input.email ?? "").trim().slice(0, 120), p_age: age,
    p_sex: input.sex ?? null, p_reason: String(input.reason ?? "").slice(0, 300), p_token_hash: hmac("booking", token), p_ip: await clientIp(),
  });
  if (error) return { ok: false, error: friendly(error) };
  return { ok: true, link: `/c/${input.slug}/booking/${token}` };
}

export async function cancelMyBooking(slug: string, token: string, reason?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!SLUG.test(slug) || !/^[A-Za-z0-9_-]{30,80}$/.test(token)) return { ok: false, error: "This link isn't valid." };
  const { error } = await serviceClient().rpc("cancel_booking_by_token", { p_slug: slug, p_token_hash: hmac("booking", token), p_reason: reason ?? null });
  if (error) return { ok: false, error: friendly(error) };
  return { ok: true };
}
