import { AuthFrame } from "@/components/auth/auth-frame";
import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { serviceClient } from "@/lib/supabase/service";
import { hmac } from "@/lib/auth/hmac";

export const metadata = { title: "Accept your invite", robots: { index: false } };
export const dynamic = "force-dynamic";

// One-time invite link (W-01 §5). Shows only the clinic name and the invited person's email;
// a dead link says so without revealing anything else.
export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = /^[A-Za-z0-9_-]{30,80}$/.test(token);
  const { data } = valid
    ? await serviceClient().rpc("invite_preview", { p_token_hash: hmac("invite", token) }).maybeSingle<{ tenant_name: string; member_name: string; email: string | null; username: string | null }>()
    : { data: null };
  if (!data || !(data.email || data.username)) {
    return (
      <AuthFrame brand={<p className="text-2xl font-semibold">CMediSewa</p>} subtitle="Invite link">
        <p className="text-ink-soft">This invite link has expired or was already used. Ask for a new one.</p>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame brand={<p className="text-xl font-semibold">{data.tenant_name}</p>} subtitle={`Welcome, ${data.member_name}. Set up your account.`}>
      <AcceptInviteForm token={token} email={data.email ?? `Username: ${data.username}`} />
    </AuthFrame>
  );
}
