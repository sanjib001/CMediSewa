/**
 * "Dr. Name" for display: staff often enter the doctor's display name as "Dr. Anjali Shrestha",
 * so add the title only when it isn't there already (no "Dr. Dr. …"). Same rule as dr_name() in SQL.
 */
export function drName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "the doctor";
  return /^dr\.?\s/i.test(n) ? n : `Dr. ${n}`;
}
