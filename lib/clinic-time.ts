// The ONLY place CMediSewa does date arithmetic (D-14; HRestroSewa's business-day.ts rule).
//
// * Instants are stored in UTC. Everything a person sees or a report buckets by is the
//   LOCAL calendar date in the tenant's timezone, which at launch is always Asia/Kathmandu
//   (UTC+05:45, no daylight saving).
// * Bikram Sambat (BS) dates come from `nepali-date-converter`, cross-checked against a
//   second library in tests and when the DB fiscal calendar is generated.
// * The fiscal year here MUST agree with SQL `fiscal_year_of()` (migration 0004); a test
//   compares the two over every seeded boundary.
import NepaliDate from "nepali-date-converter";

export const DEFAULT_TZ = "Asia/Kathmandu";

export type LocalDate = { year: number; month: number; day: number }; // month 1–12
export type BsDate = { year: number; month: number; day: number };    // month 1–12 (1 = Baisakh)

const BS_MONTHS_EN = [
  "Baisakh", "Jestha", "Asar", "Shrawan", "Bhadra", "Asoj",
  "Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra",
] as const;

/** The calendar date of an instant in `tz` (default Kathmandu). */
export function localDate(at: Date, tz: string = DEFAULT_TZ): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** The local hour (0–23) of an instant in `tz`. */
export function localHour(at: Date, tz: string = DEFAULT_TZ): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(at);
  return Number(h);
}

export function isoDate(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** AD calendar date → BS date. Throws outside the library's range (2000–2090 BS). */
export function adToBs(d: LocalDate): BsDate {
  // Construct at local noon so no timezone of the runtime can shift the day.
  const nd = new NepaliDate(new Date(d.year, d.month - 1, d.day, 12));
  return { year: nd.getYear(), month: nd.getMonth() + 1, day: nd.getDate() };
}

/** BS date → AD calendar date. */
export function bsToAd(b: BsDate): LocalDate {
  const js = new NepaliDate(b.year, b.month - 1, b.day).toJsDate();
  return { year: js.getFullYear(), month: js.getMonth() + 1, day: js.getDate() };
}

/** "2083 Shrawan 4", for printouts and patient-facing screens (shown next to the AD date). */
export function formatBs(b: BsDate): string {
  return `${b.year} ${BS_MONTHS_EN[b.month - 1]} ${b.day}`;
}

/** The Nepali fiscal year (1 Shrawan → end of Asar) an instant belongs to, e.g. "2082/83". */
export function fiscalYearOf(at: Date, tz: string = DEFAULT_TZ): string {
  const bs = adToBs(localDate(at, tz));
  const start = bs.month >= 4 ? bs.year : bs.year - 1; // Shrawan is BS month 4
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * The business day an instant belongs to, given the tenant's closing hour
 * (`tenant_settings.day_closing_hour`). With closing hour 2, a sale at 01:30 belongs to the
 * previous day's report. Closing hour 0 = the plain local date.
 */
export function businessDay(at: Date, closingHour = 0, tz: string = DEFAULT_TZ): LocalDate {
  if (!Number.isInteger(closingHour) || closingHour < 0 || closingHour > 23) {
    throw new RangeError(`closing hour must be 0–23, got ${closingHour}`);
  }
  if (closingHour === 0 || localHour(at, tz) >= closingHour) return localDate(at, tz);
  return localDate(new Date(at.getTime() - 24 * 3600_000), tz);
}
