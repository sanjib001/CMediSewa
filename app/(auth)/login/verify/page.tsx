import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth/auth-frame";
import { StepUpForm } from "@/components/auth/step-up-form";
import { getTenantContext, staffLoginPath } from "@/lib/auth/context";
import { safeNext } from "@/lib/auth/session";

export const metadata = { title: "Confirm it's you" };
export const dynamic = "force-dynamic";

// L6 step-up: reached when an operation needs a stronger session than the one held
// (e.g. a PIN session opening the Admin area or a patient record, permissions.md §3).
export default async function StepUp({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const ctx = await getTenantContext();
  if (!ctx) redirect(await staffLoginPath());
  const { next } = await searchParams;
  return (
    <AuthFrame brand={<p className="text-xl font-semibold">{ctx.tenantName}</p>} subtitle={ctx.displayName}>
      <p className="mb-4 text-ink-soft">This needs your password, not just your PIN.</p>
      <StepUpForm next={safeNext(next, "/employee")} />
    </AuthFrame>
  );
}
