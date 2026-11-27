// Phone numbers as typed at a Nepali counter: Nepali digits (९८४१…) become 0–9, spaces are tidied.
// The database accepts 7–20 characters of digits, spaces, +, -, ( and ) (customer_phone_check,
// patients_phone_check); phoneProblem says in plain words what is wrong before that refusal.

const NEPALI_DIGITS = "०१२३४५६७८९";

export function normalizePhone(raw: string | null | undefined): string {
  return String(raw ?? "")
    .replace(/[०-९]/g, (d) => String(NEPALI_DIGITS.indexOf(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** null when the phone is fine (or empty); otherwise what to fix. Expects normalizePhone() output. */
export function phoneProblem(phone: string): string | null {
  if (!phone) return null;
  if (/[\/,;]/.test(phone)) return "Enter one phone number only.";
  if (/[^0-9+() -]/.test(phone)) return "A phone number uses digits only (spaces, +, - and brackets are fine).";
  const digits = phone.replace(/\D/g, "").length;
  if (digits < 7) return "That phone number is too short: enter at least 7 digits, e.g. 9841234567.";
  if (phone.length > 20) return "That phone number is too long.";
  return null;
}
