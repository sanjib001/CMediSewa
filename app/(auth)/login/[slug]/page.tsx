import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { AuthFrame } from "@/components/auth/auth-frame";
import { PinSignIn } from "@/components/auth/pin-sign-in";
import { serviceClient } from "@/lib/supabase/service";
import { hmac, DEVICE_COOKIE } from "@/lib/auth/hmac";

export const metadata = { title: "Clinic sign-in" };
export const dynamic = "force-dynamic";

// L3/L4: the clinic link. The slug only selects branding; it never authorises anything.
// The trusted-device cookie decides between the PIN picker and the password form, and an
// untrusted device never receives the staff list.
export default async function ClinicSignIn({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ idle?: string }> }) {
  const { slug } = await params;
  const idle = (await searchParams).idle === "1";
  const db = serviceClient();
  const { data: tenant } = await db.from("tenants").select("id, name, status").eq("slug", slug).neq("status", "closed").maybeSingle<{ id: string; name: string; status: string }>();
  if (!tenant) notFound();

  const token = (await cookies()).get(DEVICE_COOKIE)?.value;
  let staff: { member_id: string; display_name: string; title: string | null }[] = [];
  let trusted = false;
  if (token) {
    const hash = hmac("device", token);
    const { data: device } = await db.from("trusted_devices").select("id").eq("tenant_id", tenant.id).eq("token_hash", hash).is("revoked_at", null).maybeSingle();
    trusted = Boolean(device);
    if (trusted) {
      const { data } = await db.rpc("device_staff_picker", { p_tenant: tenant.id, p_device_token_hash: hash });
      staff = (data ?? []) as typeof staff;
    }
  }

  return (
    <AuthFrame
      brand={
        <div className="flex flex-col items-center gap-2">
          <span className="grid size-12 place-items-center rounded-panel bg-pine text-lg font-bold text-white" aria-hidden>
            {tenant.name.trim().charAt(0).toUpperCase()}
          </span>
          <p className="text-xl font-semibold leading-tight">{tenant.name}</p>
          {tenant.status === "suspended" ? <p className="text-sm text-alert">This clinic&apos;s account is suspended.</p> : null}
        </div>
      }
    >
      {idle ? <p role="status" className="mb-4 rounded-control bg-warn-tint px-3 py-2 text-sm text-warn">You were signed out because this screen was not used for a while (the clinic&apos;s screen-lock time). Sign in again to continue.</p> : null}
      <PinSignIn slug={slug} trusted={trusted} staff={staff} />
    </AuthFrame>
  );
}
