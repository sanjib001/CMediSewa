"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";

// Notifications (B9a): read marks and this device's push subscription. Any signed-in staff
// member (A1) manages their own; the database scopes every call to that member.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const me = () => requireTenant({ operation: "employee.area", allowPendingTenant: true, next: "/employee/notifications" });

export async function markRead(ids: string[] | null): Promise<{ ok: true }> {
  const ctx = await me();
  const list = ids ? ids.filter((i) => UUID.test(i)).slice(0, 200) : null;
  await serviceClient().rpc("mark_notifications_read", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_ids: list });
  revalidatePath("/employee/notifications");
  return { ok: true };
}

export async function savePushSubscription(input: { endpoint: string; p256dh: string; auth: string; ua?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await me();
  if (!/^https:\/\/[^\s]{10,1000}$/.test(input.endpoint ?? "") || !/^[A-Za-z0-9_-]{20,200}$/.test(input.p256dh ?? "") || !/^[A-Za-z0-9_-]{8,100}$/.test(input.auth ?? "")) {
    return { ok: false, error: "This browser gave an unusable push address." };
  }
  const { error } = await serviceClient().rpc("save_push_subscription", {
    p_tenant: ctx.tenantId, p_member: ctx.memberId, p_endpoint: input.endpoint, p_p256dh: input.p256dh, p_auth: input.auth, p_ua: String(input.ua ?? "").slice(0, 300),
  });
  return error ? { ok: false, error: "Couldn't turn on notifications. Try again." } : { ok: true };
}

export async function removePushSubscription(endpoint: string): Promise<{ ok: true }> {
  const ctx = await me();
  await serviceClient().rpc("remove_push_subscription", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_endpoint: String(endpoint ?? "").slice(0, 1000) });
  return { ok: true };
}
