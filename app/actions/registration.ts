"use server";

import { serviceClient } from "@/lib/supabase/service";
import { clientIp } from "@/lib/auth/session";
import { headers } from "next/headers";
import { audit } from "@/lib/audit";

export type RegisterResult = { ok: true } | { ok: false; error: string };

/**
 * Marketing-site registration (W-01 step 1). Public, so: a honeypot field, per-IP and
 * per-email limits inside submit_tenant_application(), strict validation, and the same
 * response shape whatever happens to an existing email. CAPTCHA arrives with Turnstile keys.
 */
export async function submitRegistration(fd: FormData): Promise<RegisterResult> {
  const v = (k: string) => String(fd.get(k) ?? "").trim();
  if (v("website")) return { ok: true }; // honeypot: bots fill every field; pretend success

  const business = v("business_name"), owner = v("owner_name"), email = v("email").toLowerCase(), phone = v("phone");
  if (business.length < 2 || business.length > 120) return { ok: false, error: "Enter your clinic's name." };
  if (owner.length < 2 || owner.length > 80) return { ok: false, error: "Enter the owner's or manager's name." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (!/^[0-9+ -]{7,20}$/.test(phone)) return { ok: false, error: "Enter a phone number we can call." };
  if (fd.get("consent") !== "on") return { ok: false, error: "Please agree to be contacted about your registration." };
  const message = v("message");
  if (message.length > 1000) return { ok: false, error: "Keep the message under 1000 characters." };

  const { data, error } = await serviceClient().rpc("submit_tenant_application", {
    p_business_name: business, p_owner_name: owner, p_email: email, p_phone: phone,
    p_district: v("district"), p_municipality: v("municipality"), p_pan: v("pan"),
    p_plan: v("plan_id") || null, p_message: message, p_ip: await clientIp(), p_user_agent: (await headers()).get("user-agent") ?? "",
  });
  if (error) return { ok: false, error: "We couldn't send your registration. Please try again or call us." };
  if (data === "RATE_LIMITED") return { ok: false, error: "Too many registrations from this connection today. Please call us instead." };
  // ALREADY_SUBMITTED answers like success: the form never confirms which emails are on file.
  if (data === "OK") await audit({ actorKind: "guest_token", action: "application.submit", outcome: "success", detail: { email_domain: email.split("@")[1] } });
  return { ok: true };
}
