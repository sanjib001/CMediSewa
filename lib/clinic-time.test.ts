import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { localDate, adToBs, bsToAd, fiscalYearOf, businessDay, formatBs, isoDate } from "./clinic-time.ts";

const require = createRequire(import.meta.url);
const bikram = require("bikram-sambat");

test("local date uses Kathmandu (UTC+05:45), not UTC", () => {
  assert.equal(isoDate(localDate(new Date("2026-07-16T18:14:59Z"))), "2026-07-16");
  assert.equal(isoDate(localDate(new Date("2026-07-16T18:15:00Z"))), "2026-07-17");
});

test("known BS reference dates", () => {
  assert.deepEqual(adToBs({ year: 2026, month: 4, day: 14 }), { year: 2083, month: 1, day: 1 }); // BS new year 2083
  assert.deepEqual(adToBs({ year: 2025, month: 7, day: 17 }), { year: 2082, month: 4, day: 1 }); // 1 Shrawan 2082
  assert.deepEqual(bsToAd({ year: 2081, month: 4, day: 1 }), { year: 2024, month: 7, day: 16 });
  assert.equal(formatBs({ year: 2083, month: 4, day: 4 }), "2083 Shrawan 4");
});

test("AD→BS agrees with an independent library on every day of 2013–2033", () => {
  const d = new Date(Date.UTC(2013, 6, 1));
  const end = Date.UTC(2033, 6, 1);
  let checked = 0;
  for (; d.getTime() < end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ad = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const ours = adToBs(ad);
    const theirs = bikram.toBik(isoDate(ad));
    assert.deepEqual([ours.year, ours.month, ours.day], [theirs.year, theirs.month, theirs.day], `mismatch on ${isoDate(ad)}`);
    checked++;
  }
  assert.ok(checked > 7000);
});

test("fiscal year matches the generated SQL fiscal calendar at every boundary", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/20261120100300_fiscal_calendar.sql", import.meta.url), "utf8");
  const rows = [...sql.matchAll(/\('(\d{4}\/\d{2})', \d{4}, date '([\d-]+)', date '([\d-]+)'\)/g)];
  assert.ok(rows.length >= 20);
  for (const [, code, starts, ends] of rows) {
    // Local noon on the first and last day of each fiscal year (+05:45 written explicitly).
    assert.equal(fiscalYearOf(new Date(`${starts}T12:00:00+05:45`)), code, `start of ${code}`);
    assert.equal(fiscalYearOf(new Date(`${ends}T12:00:00+05:45`)), code, `end of ${code}`);
  }
  // The local-midnight edge, as tested in SQL too.
  assert.equal(fiscalYearOf(new Date("2026-07-16T18:14:59Z")), "2082/83");
  assert.equal(fiscalYearOf(new Date("2026-07-16T18:15:00Z")), "2083/84");
});

test("business day honours the closing hour", () => {
  const at0130 = new Date("2026-11-20T01:30:00+05:45");
  assert.equal(isoDate(businessDay(at0130, 0)), "2026-11-20");
  assert.equal(isoDate(businessDay(at0130, 2)), "2026-11-19");
  assert.equal(isoDate(businessDay(new Date("2026-11-20T02:00:00+05:45"), 2)), "2026-11-20");
  assert.throws(() => businessDay(at0130, 24), RangeError);
});
