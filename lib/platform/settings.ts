import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Platform settings (U2): the support contact shown on the public Contact page and whether new
// clinic registrations are open. One row; changed by a platform admin (set_platform_settings).

export type PlatformSettings = {
  support_phone: string | null; support_email: string | null; support_whatsapp: string | null;
  support_hours: string | null; office_address: string | null; registrations_open: boolean; updated_at: string | null;
};
const EMPTY: PlatformSettings = { support_phone: null, support_email: null, support_whatsapp: null, support_hours: null, office_address: null, registrations_open: true, updated_at: null };

/** Read the settings; with no database (CI build) the defaults are used so pages still render. */
export async function getPlatformSettings(): Promise<PlatformSettings> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return EMPTY;
  const { data } = await serviceClient().from("platform_settings").select("support_phone, support_email, support_whatsapp, support_hours, office_address, registrations_open, updated_at").maybeSingle();
  return (data as PlatformSettings | null) ?? EMPTY;
}

export type PlatformHealth = {
  last_nightly: string | null; stock_repaired_7d: number; errors_24h: number; denied_24h: number;
  outbox_waiting: number; outbox_failed_7d: number; outbox_dry_run_7d: number; outbox_sent_7d: number;
  finance_mismatch: { tenant: string; slug: string; mismatches: number; at: string }[];
  payable_mismatch: { tenant: string; slug: string; mismatches: number }[];
  expiring_14d: { tenant: string; slug: string; until: string }[];
};
export async function getPlatformHealth(): Promise<PlatformHealth> {
  const { data, error } = await serviceClient().rpc("platform_health");
  if (error) throw new Error(`health: ${error.message}`);
  return data as PlatformHealth;
}
