import { cookies } from "next/headers";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { hmac, DEVICE_COOKIE } from "@/lib/auth/hmac";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { DevicesPanel } from "@/components/auth/devices-panel";

export const metadata = { title: "Trusted devices" };
export const dynamic = "force-dynamic";

// devices.manage = A3 (password + authenticator) or a re-auth within 5 minutes (permissions.md §3).
export default async function Devices() {
  const ctx = await requireTenant({ operation: "devices.manage", permission: "manage_staff", allowPendingTenant: true, next: "/admin/devices" });
  const db = serviceClient();
  const { data } = await db.from("trusted_devices").select("id, name, enrolled_at, last_used_at, revoked_at, token_hash")
    .eq("tenant_id", ctx.tenantId).order("enrolled_at", { ascending: false });
  const token = (await cookies()).get(DEVICE_COOKIE)?.value;
  const hash = token ? hmac("device", token) : null;
  const rows = (data ?? []) as { id: string; name: string; enrolled_at: string; last_used_at: string | null; revoked_at: string | null; token_hash: string }[];
  const thisDevice = rows.find((d) => d.token_hash === hash && !d.revoked_at)?.id ?? null;
  return (
    <>
      <PageHeader title="Trusted devices" subtitle="Staff can sign in with their PIN only on these devices, using your clinic's sign-in link." />
      <Panel>
        {/* The token hash never leaves the server. */}
        <DevicesPanel devices={rows.map((d) => ({ id: d.id, name: d.name, enrolled_at: d.enrolled_at, last_used_at: d.last_used_at, revoked_at: d.revoked_at }))} thisDeviceId={thisDevice} />
      </Panel>
    </>
  );
}
