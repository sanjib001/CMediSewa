import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { SetPinForm } from "@/components/auth/set-pin-form";

export const metadata = { title: "My PIN" };
export const dynamic = "force-dynamic";

// Setting a PIN needs a password session (A2): a PIN cannot be used to change a PIN.
export default async function MyPin() {
  const ctx = await requireTenant({ operation: "admin.area", allowPendingTenant: true, next: "/employee/pin" });
  const { data: hasPin } = await serviceClient().rpc("member_has_pin", { p_member: ctx.memberId });
  return (
    <>
      <PageHeader title="My PIN" />
      <Panel><SetPinForm hasPin={Boolean(hasPin)} /></Panel>
    </>
  );
}
