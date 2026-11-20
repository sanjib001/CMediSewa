import "server-only";
import { headers } from "next/headers";
import { serviceClient } from "@/lib/supabase/service";

export type AuditEvent = {
  tenantId?: string | null;
  actorKind: "member" | "platform_admin" | "patient_account" | "guest_token" | "system";
  actorId?: string | null;
  sessionLevel?: "A1" | "A2" | "A3" | null;
  action: string; // domain.verb
  targetType?: string;
  targetId?: string;
  outcome?: "success" | "denied" | "error";
  reason?: string;
  detail?: Record<string, unknown>;
};

/**
 * Append to audit_log (append-only, D-23). Never put passwords, codes or clinical text in
 * `detail`. A failed audit write is thrown, not swallowed: an action that must be audited
 * must not appear to succeed without its record.
 */
export async function audit(e: AuditEvent): Promise<void> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  const { error } = await serviceClient().from("audit_log").insert({
    tenant_id: e.tenantId ?? null,
    actor_kind: e.actorKind,
    actor_id: e.actorId ?? null,
    session_level: e.sessionLevel ?? null,
    action: e.action,
    target_type: e.targetType ?? null,
    target_id: e.targetId ?? null,
    outcome: e.outcome ?? "success",
    reason: e.reason ?? null,
    ip: ip && /^[0-9a-f:.]+$/i.test(ip) ? ip : null,
    user_agent: h.get("user-agent")?.slice(0, 300) ?? null,
    detail: e.detail ?? null,
  });
  if (error) throw new Error(`audit write failed: ${error.code ?? ""} ${error.message}`);
}
