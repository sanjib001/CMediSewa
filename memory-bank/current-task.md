# Current Task

## ▶ Resume here (handoff, 2026-11-26)
Read this section first in every new conversation, then `decisions.md` (latest D-numbers) and
`pilot-checklist.md`.

**Where we are**
- Phase 0 (backend B0–B9) and Phase 1 (screens U1–U8) are **complete and committed**.
- Phase 2: M-37 patient merge, M-52 patient advances, M-51 bulk recall committed.
- **Pharmacy track (owner, D-142): complete.** Steps 1–4 committed (D-141, D-143, D-144, D-145);
  step 5 moved to Future (D-146); step 6 substitutes (D-147) done 2026-11-26, the owner commits
  it. 66 migrations (last `20261126130000_one_batch_one_lot.sql`, applied to dev), decisions D-01…D-152.
- Owner-facing guide: `docs/guides/setup-and-user-guide.md` + `CMediSewa-Setup-and-User-Guide.pdf`
  (Super Admin setup, clinic setup in order, daily work, limits). Keep it in step with the app;
  rebuild the PDF with `.local-tools/ui/guide-pdf.mjs`.
- Last fixes: idle lock covers the whole window, phone-width layouts, "Dr. Dr." names (D-135);
  medicine save accepts "500mg" / "1,000" and names the bad field (`app/actions/inventory.ts`).

**Next step: simpler screens, step 2** (owner, D-148/D-149: no Nepali; make screens simpler, hide
or delete what isn't essential). Step 1 done 2026-11-26 (removals + the medicine form). Step 2:
the other detailed forms in the same way: the purchase bill (Purchases → New), opening stock,
Settings ("How the clinic runs" folded into essentials + More), then an overall look pass
(dashboard, menus, the pharmacy counter). Ask the owner before deleting anything else.
Phase 2 as trimmed by the owner: ~~M-37 patient merge~~ · ~~M-52 patient advances~~ · ~~M-51 bulk recall~~ ·
~~M-46 purchase suggestions~~ · ~~M-45 stock reservations~~ · Nepali UI · later online payments, patient
documents, subdomains. **Dropped to Future:** SMS M-32 (D-136), controlled-drug register M-48 and
cashier shifts M-47 (D-137), advanced barcodes M-49 (D-146). Controlled/narcotic items stay blocked from sale.

**Database and data**
- Only a **development** database exists (`.env.local`); no production DB yet (pilot checklist §2).
- It holds two clinics: `arogya-demo` (seeded with one realistic day for demos; staff sign-ins in
  gitignored `scripts/dev-users.local.json`) and the owner's own `sanjib` (real use: don't touch);
  one real Super Admin. All test clinics were purged.
- E2E runs create clinics named "… (safe to ignore)": **purge them after testing**
  (`.local-tools/purge-test-clinics.mjs`, dry run first).

**How the owner works**
- Says "next": build the recommended step, then end with a grouped **commit guide** (git add +
  message). **The owner commits and pushes; never commit.** No Co-Authored-By / Claude lines.
- The owner does the final hands-on UI test. Their Chrome extension can't reach this PC, so test
  with headless Chrome (playwright-core, `channel: "chrome"`).
- Bug reports come short: reproduce first (DB in a rolled-back transaction, then the app); ask for
  the exact error text only if that fails.
- Never print or repeat secrets. Never modify HRestroSewa.

**Testing and tools**
- Local tools in `.local-tools/` (not committed; excluded in `.git/info/exclude`):
  `q.mjs` (SQL on dev: `node --env-file=.env.local .local-tools/q.mjs "select …"`), `reapply2.mjs`,
  `e2e-pilot.mjs` + `e2e-ui-body.mjs` (full journey + browser pass; on a production build run
  `E2E_BASE=http://localhost:3100 node --env-file=.env.local .local-tools/e2e-pilot.mjs`), `seed-demo-day.mjs`,
  `purge-test-clinics.mjs` / `purge-test-admins.mjs` (dry run unless `--apply`), `try-item.mjs`,
  `ui/guide-pdf.mjs` (Markdown → PDF), `pglite/server.mjs` (fresh-replay DB). Reinstall packages
  next to them: `npm i playwright-core@1.49.1 marked@12.0.2` in `ui/`, and `npm i` in `pglite/`.
- The long-running `next dev` goes stale after many edits (saves fail, pages loop): verify on a
  production build (`npm run build` + `npx next start -p 3100`, stop it by port afterwards) and
  tell the owner to restart `next dev`.
- Before calling a big step done (database, money, stock, permissions): `npm test`, `npm run test:db`,
  `node scripts/check-posture.mjs`, typecheck, lint, build, and the E2E journey on a production build.
- **Small edits (owner, 2026-11-27):** labels, columns, layout, wording: typecheck, lint and a quick
  check of that screen only; run the full E2E at the end of a batch of small edits or when asked.
- When a step finishes, **update this section** and add decisions to `decisions.md`.

---

**Phase:** Phase 0 and Phase 1 complete. **Pilot preparation:** work through `memory-bank/pilot-checklist.md` (decisions, production setup, email, clinic setup, real-device pass, dry run).
**Last updated:** 2026-11-26

## Simpler screens, step 1: done (2026-11-26)
| Item | Status |
|---|---|
| Removed (screens and app code): vendor performance, account statement, payables check panel; Transfers page and forms, Add a store, Who works in this store, Levels per store; pharmacy Dues tab | done |
| Migration 0065: store access follows the role when there is no store_members row | done |
| Medicine form: essentials first (name, generic, strength, form, sold, pack preset with summary, reorder level), the rest under More details; menu "Stock"; guide updated (C6, C7, C8, E3, E4) | done |
| Checks | DB **139/139** · posture ✓ · **E2E 319/319 on a production build** (one run hit a one-off DB statement timeout in the advance step; the rerun passed) · typecheck/lint/build ✓ · test clinics purged |
| Fixed (owner: "unable to add a purchase", sanjib) | the DB posts a bill for that clinic fine (checked in a rolled-back transaction); the bill form was the problem: item search matched only the brand name and showed nothing when there was no match, the Post button was greyed out without saying why, and a medicine line without a batch failed with "Something went wrong". Now: search by name, generic or code, a "No item matches… Add it in Medicines" hint, Post explains what is missing (bill no., items, qty, rate, batch, expiry per line), and the batch error is worded. New browser check of the whole form: **E2E 326/326** |
| Fixed (owner: "pay in cash and online don't seem to work") | the DB recorded them correctly; the form only changed one small "On credit" figure. Now: "Paying the vendor now?" with Cash now / Online now / Online via, Pay all in cash / Pay all online / All on credit, "Paid now" lines in the summary, a warning (and a block) when more is paid than the bill, and the form total uses the same per-line rounding as post_purchase_invoice so Pay all matches to the paisa. Browser check: full cash with VAT + bill discount, and part cash + part online + credit: **E2E 331/331** |
| Fixed (owner: "Enter a valid phone number" while selling, no box to fix it) | the Name / Phone boxes hide once a patient is linked, but text typed in them before was still sent and refused by customer_phone_check. Now: with a linked patient they are not sent (the card shows the patient's own phone); lib/phone.ts converts Nepali digits and names the problem (too short, two numbers, letters) under the box and in the sale / hold actions. Unit test added. **E2E 369/369** |
| Checked (owner: "staff get logged out often") | cause: the idle lock (Settings → Lock the screen after, 10 min; at least 15 min on a device that is not trusted) signs the session out after that idle time + 60 s; sanjib staff sessions on 27 Nov ended after 55, 26 and 17 min. Now the sign-out is audited with its reason (idle / manual, the lock minutes, trusted device) and the sign-in page says "signed out because this screen was not used for a while". No setting changed: the owner decides the lock time |
| Changed (owner, D-156) | **UI upgrade, step 1**: Admin dashboard (BS date, patient flow, Needs you, OPD queues with tokens, money), Pharmacy (two-pane counter with sticky pay panel, compact Dispense, Bills with status chips, Holds count), clinic website (In OPD today + Book first, weekly OPD strip, pinned Call / Book on phones; fixed sideways scroll on phones). Screens reviewed by screenshot at 1366 and 390 px. **E2E 369/369**, build ✓. Next: the remaining screens (registrar, OPD, admin lists) in the same style when the owner asks |
| Changed (owner, D-155) | **printed bill**: professional, simple invoice (header with PAN, ruled title, BS date, numbered lines with batch, totals, paid by, amount in words, footer); prints on Settings → Receipt paper (80/58 mm or A5/A4, which was not used before) and only the bill prints. **E2E 369/369** |
| Added (owner, D-154) | **selling by keyboard** at the pharmacy counter: type → matches with ↑/↓ highlight → Enter adds and goes to Qty → Unit → Disc % → back to search; Enter in the empty search → Cash. **E2E 365/365** |
| Added (owner, D-154) | **keyboard form filling** everywhere: Enter = next box, last box → Save button, → / ← at the text's edge = next / previous box; search/scan boxes, notes and one-box forms unchanged. Browser check fills and saves a medicine by keyboard only. **E2E 357/357** (two earlier runs hit the dev DB's 8 s statement timeout in the advance step, unrelated) |
| Changed (owner) | the top-right switch into the Admin area says **Purchase & management** for staff who aren't clinic admins (e.g. pharmacy); clinic admins keep "Admin" (tenantBarProps.adminLabel). **E2E 349/349** |
| Fixed (owner: pharmacy staff see things they aren't allowed to, D-153) | menu entries for Doctors & schedules and Departments & services now need their keys; Reports shows for any allowed report; the Admin dashboard shows patient counts, OPD queues, booking requests, the registrar button and the setup list only with their keys; getAdvance needs a billing or sale key. E2E checks as the pharmacist and the owner. **E2E 347/347** |
| Added (owner, D-152, migration 0066) | **one batch, one lot**: the same batch bought again (same medicine, vendor, expiry, cost per unit, MRP, sale price) adds to the existing lot, so Stock shows one row; different cost/MRP/vendor stays separate. Void allowed while the bill's stock is still on the shelf; returns against a bill limited to what it brought. E2E's booking-email check now reads the confirmation (after midnight a reminder is queued too). DB **140/140**, fresh replay of all 66 migrations + posture ✓, **E2E 342/342** |
| Added (owner, D-151) | vendor bill: a batch number already on file for that medicine fills its expiry (and MRP when blank) on leaving the batch box; a different expiry or MRP shows a warning. **E2E 340/340** |
| Added (owner) | Stock table: **Sale value** (on hand × the batch sale price) beside Cost value, and "Rs. X at sale price" in the page line; columns now Item · Batch · Expiry · Quantity · Cost value · Sale value · MRP / unit (MRP moved right); store buttons no longer say "Pharmacy Pharmacy". **E2E 338/338** |
| Added (owner, D-150) | each line shows its **item cost** per unit and per base unit (as the lot is valued; checked against item_batches.unit_cost_base) and the MRP margin; lines start at **Batch** (then Expiry, Unit, Qty, Free, Rate, Disc %, VAT, MRP, Amount) with the cursor in Batch when an item is added. **E2E 336/336** (one run hit a page-load timeout in the holds step; the rerun passed) |
| Added (owner) | the bill form shows each line's Amount (qty × rate, less its discount, plus its VAT) and, under the items, the count, VAT, Total and the total after the bill discount; the VAT box is wider (13% was cut off); editing the line an error points at clears that error. The M-37 Undo browser check now waits for the Combined records panel to go (the message unmounts with it): it had failed twice in a row. **E2E 333/333** |

## Pharmacy step 6, substitutes: done (2026-11-26)
| Item | Status |
|---|---|
| Migration 0064: medicine_equivalent, medicine_substitutes, substitute rule + reason in issue_counter_sale and create_stock_hold (stock_hold_lines.substitution_reason), dispensing_queue returns item_id | done |
| Counter: prescription line starts with the prescribed item or the same medicine in stock, list limited to the same medicine, reason with quick choices; search offers the same medicine for an out-of-stock brand; bill prints "in place of the prescribed brand: reason"; guide updated (E3) | done |
| Checks | DB **139/139** (3 new) · fresh replay of all 64 migrations + posture ✓ · **E2E 318/318 on a production build** incl. the same-medicine suggestion and the prescribed item chosen in headless Chrome · typecheck/lint/build ✓ · posture ✓ · test clinics purged |
| Generator | 0064 copies create_stock_hold and issue_counter_sale from 0063 and dispensing_queue from 0060 with exact insertions; edit the migration file itself from now on |

## Pharmacy step 4, M-45 stock holds: done (2026-11-26)
| Item | Status |
|---|---|
| Migration 0063: stock_holds / stock_hold_lines, sync_reserved, create_stock_hold, release_stock_hold, release_expired_holds (allocate_stock, counter sale and nightly job), lot-status trigger, collection in issue_counter_sale (hold_line_id) | done |
| Sale tab "Hold for later" (1/2/3/7 days); Holds tab (collect and bill, release with reason, ended in the last 3 days); collection prefill pinned to the held lots; counter shows only unheld stock; Dispense tab "On hold"; guide updated (E3) | done |
| Checks | DB **136/136** (4 new) · fresh replay of all 63 migrations + posture ✓ · **E2E 309/309 on a production build** incl. hold and collect in headless Chrome, phone width · typecheck/lint/build ✓ · posture ✓ · test clinics purged |
| Generator | the issue_counter_sale body in 0063 was taken from the live database (pg_get_functiondef) with exact insertions for hold collection; edit the migration file itself from now on |

## Pharmacy step 3, M-46 purchase suggestions and supplier performance: done (2026-11-26)
| Item | Status |
|---|---|
| Migration 0062: purchase_plan (use per day × delivery time + cover days, levels, on order), vendor_lead_days, vendor_performance, PO approval limit (pending_approval, decide_purchase_order, notifications), vendors.lead_time_days, tenant_settings.reorder_cover_days / po_approval_limit | done |
| Reorder page grouped by vendor with 30/60/90-day speed and one-click draft orders; orders "Needs approval" banner, approve/reject on the order; vendor page "How this vendor has done" and delivery time; Settings fields; guide updated (C2, C9, E4) | done |
| Checks | DB **132/132** (3 new) · fresh replay of all 62 migrations + posture ✓ · **E2E 299/299 on a production build** incl. the one-click draft in headless Chrome, phone width · typecheck/lint/build ✓ · posture ✓ · test clinics purged |

## Pharmacy step 2, purchasing gaps: done (2026-11-25)
| Item | Status |
|---|---|
| Migration 0061: apply_vendor_credit (payments and credit notes → open bills, oldest first, one posting); post_stock_adjustment makes found lots properly (capital batch, expiry for medicines, MRP and sale price) | done |
| Vendor page "Credit with this vendor" + Use credit; Medicines → item "Levels per store"; Stock "Found stock" form; guide updated (E4) | done |
| Checks | DB **129/129** (2 new) · fresh replay of all 61 migrations + posture ✓ · **E2E 285/285 on a production build** incl. found stock in headless Chrome · typecheck/lint/build ✓ · posture ✓ · test clinics purged |

## Pharmacy step 1, counter and dispensing gaps: done (2026-11-25)
| Item | Status |
|---|---|
| Migration 0060: rx_item_dispensed_base / rx_item_done, dispensing queue with given/left, credit limit counts invoice_outstanding (check-in and counter), post_sale_return 'to_advance' | done |
| Dispense tab "N given, M left" and prefill of what is left; return form "Into the patient's advance"; return slip page and links on the bill; guide updated (E3) | done |
| Fixed | an M-37 test booked "2 hours from now" and failed after 22:00 Nepal time (check-in needs today); it now books "now" |
| Checks | DB **127/127** (3 new) · fresh replay of all 60 migrations + posture ✓ · **E2E 272/272 on a production build** · typecheck/lint/build ✓ · posture ✓ · test clinics purged |

## M-51 Bulk recall: done (2026-11-25)
| Item | Status |
|---|---|
| Migration 0059: batch_recalls, batch_recall_lots, recall_batch (every lot of the medicine with that batch number → recalled, history, audit, notifications), recall_affected_sales (bills that sold it with patient/walk-in phone, net of returns; audited read) | done |
| Admin → Stock → Recalls (form with medicine search and the batch numbers on file, past recalls); recall page (notice, lots and stock left per store, who bought it with tel: links, print); guide updated (E4) | done |
| Checks | DB **124/124** (4 new) · fresh replay of all 59 migrations + posture ✓ · **E2E 263/263 on a production build** incl. recall from the form in headless Chrome, phone width · typecheck/lint/build ✓ · posture ✓ · test clinics purged |

## M-52 Patient advances: done (2026-11-25)
| Item | Status |
|---|---|
| Migration 0058: patient_advances (AD- receipts), payments.advance_amount leg, record_patient_advance, use_patient_advance, apply_patient_advance (internal); check-in and counter sale use the advance first (0023/0044 bodies + checked substitutions); void returns the advance leg; finance report, daily summary and books check know advances; merges carry them (undo refused while the deposit is spent) | done |
| Desk "Advance" tab (take, pay from advance, give back, history), check-in form "From the advance", counter sale the same, patient page Advance panel, printable advance receipt (/employee/advance-receipt/[id]), Finance labels; guide updated (E1, E3, E4) | done |
| Checks | DB **120/120** (8 new) · fresh replay of all 58 migrations + posture ✓ · **E2E 251/251 on a production build** incl. desk and patient page in headless Chrome, phone width · typecheck/lint/build ✓ · posture ✓ · books check clean on both real dev clinics · test clinics purged |
| Generator | 0058 was built by `gen-m52.cjs` (scratchpad, not kept): the copied functions are the current bodies with exact substitutions; edit the migration file itself from now on |

## M-37 Patient merge: done (2026-11-25)
| Item | Status |
|---|---|
| Migration 0057: patients.merged_into/merged_at, patient_merges, patient_merge_rows, merge_patients, undo_patient_merge, merge-only exception in the locked-row triggers (encounters, prescriptions, vitals), old MRN still found by search_patients | done |
| Admin → Patients → patient: "Same person: combine" on each match, "Combine with another record" (MRN, which to keep, confirmation), "Combined records" with Undo; a merged record's page says where everything went; guide updated (E4) | done |
| Checks | DB **112/112** (5 new) · fresh replay of all 57 migrations + posture ✓ · **E2E 235/235 on a production build** incl. combine and undo in headless Chrome, phone width · typecheck/lint/build ✓ · posture ✓ · test clinics purged |
| Not moved on purpose | ledger_entries (append-only, never read by patient), audit_log (D-138) |

## Phase 1 review (2026-11-21)
What each U milestone asks for (roadmap) against what the B milestones already built.
| Milestone | Already there | Still to do |
|---|---|---|
| U2 Marketing + Super Admin | landing, registration, applications, clinics (+ direct creation), plans ~~all~~ done in U2 (pricing was already live) |
| U3 Admin | setup + go-live, settings, staff/roles/devices, services, doctors/schedules, website, appointments, medicines, stock, purchases, vendors, expenses, finance, reports; **U3a: dashboard on real data, Billing, Audit log** ~~Patients~~ (U3b done; merging is P2, M-37); reminder hours on Settings |
| U4 Registrar | today's board, register/search, book, check-in with OPD fee + token, queue, booking requests, live refresh ~~all four~~ done in U4 |
| U5 Doctor OPD | queue, call next, chart + allergies, consultation, e-Rx → pharmacy queue, live refresh ~~both~~ done in U5 |
| U6 Pharmacy | dispensing queue, sale (FEFO, units, batch choice), bills, returns, void, dues, stock alerts, live refresh ~~both~~ done in U6 (barcodes optional, D-126) |
| U7 Public site | site, doctors, services, slots, booking requests, status link manage link done in U7; patient account deferred (D-134) |
| U8 PWA & polish | push opt-in, service worker ~~all~~ done in U4/U8a; still to try on a real phone (install, push, iPhone standalone sign-in) |

## Browser UI pass: done (2026-11-21)
| Item | Status |
|---|---|
| Real-browser checks (headless Chrome): 15 owner pages without console errors; counter sale by mouse and keyboard → bill → print; barcode scan; registrar live update; offline banner; phone width; idle lock (covers + blurs the window, "I'm here", sign-out) | done, 16/16 |
| Fixed | idle lock covered only the top bar (privacy); phone sideways scrolling on Billing and Registrar; "Dr. Dr." in notifications, emails and prints (migration 0056) |
| Checks | **233/233 on a production build** (the whole journey + UI pass) · DB 107/107 · fresh replay of all 56 migrations ✓ · typecheck/lint/build ✓ · posture ✓ |
| Left for the owner | the final hands-on test on real devices and printers (pilot checklist §6) |

## Pilot checklist written (2026-11-21)
| Item | Status |
|---|---|
| `memory-bank/pilot-checklist.md`: decisions, production setup, email, platform content, clinic setup, real-device pass, dry run, known limits | done |
| Found while writing it: credit allowance, credit limit, discount limit and reminder hours had no screen; added to Admin → Settings (Billing and reminders), validated and audited | done (end-to-end 5/5) |

## U7 Manage link in patient emails: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0055: appointment_links, add_manage_link, appointment_by_token; public_booking_status and cancel_booking_by_token accept website or emailed links | done |
| Dispatcher mints a link per confirmation/reminder/moved email (only when really sending); email text + button; RESEND_API_BASE for relays/tests | done |
| Checks | DB 107/107 · fresh replay of all 55 migrations ✓ · **U7 end-to-end 9/9 on a production build with a local mail stub** (email sent with link, only the hash stored, link opens and cancels the booking, made-up link shows nothing, no reason for visit in the email) · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ |

## U2 Platform settings, contact, audit, health: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0054: platform_settings + set_platform_settings (audited), platform_health() | done |
| Public /contact (from settings), Contact link on the landing page, registration closed/open; Super Admin Platform settings, Platform audit, Health panel on the overview (real environment label), invoices to clinics on Plans & billing | done |
| Fixed | the settings save failed through the API (UPDATE without WHERE refused by Supabase); DB tests couldn't see it, the end-to-end test did |
| Checks | DB 106/106 · fresh replay of all 54 migrations ✓ · **U2 end-to-end 16/16 on a production build** (the running dev server held a stale module for the new action: restart `next dev` to use it) · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ |

## U8a Install, offline, idle lock: done (2026-11-21)
| Item | Status |
|---|---|
| Manifest + icons (/pwa-icon/*), iPhone home-screen metadata, service worker offline fallback (caches /offline only), offline banner, idle lock with countdown and sign-out, GRN print on purchase bills | done |
| Also | Vercel: both crons once a day (D-128) so deployments stop failing |
| Checks | **end-to-end 208/208** incl. icon PNG sizes, signed-out offline page, SW caching only /offline · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ (no migration) |
| Not yet | tried on a real phone (install prompt, push, iPhone standalone sign-in) |

## U6 Pharmacy workspace: done (2026-11-21)
| Item | Status |
|---|---|
| Barcodes optional everywhere (owner direction); medicine form says so; counter scan (code + Enter) when a barcode exists | done |
| Pharmacy Stock tab: on hand per batch, search, transfers in/out, counts at PIN level | done |
| Checks | DB 105/105 · **end-to-end 200/200** incl. a medicine saved with no barcode · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ (no migration) |
| Note | U5 changes are uncommitted too: the owner will commit U5 and U6 together |

## U5 Doctor schedule, leave, follow-ups: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0052: leave notice trigger, add_own_leave, remove_own_leave, appointments_on_leave, book_follow_up | done |
| Migration 0053: dispatcher only for active/pending clinics; closed clinics' messages cancelled | done (bug found in U5) |
| My schedule page; OPD: My schedule link and Book follow-up; Registrar: "Appointments to move: doctor on leave" with Reschedule | done |
| Fixed | doctor schedule pages used the UTC date for "today" (missed today's leave and slots before 05:45 NPT); two notification tests claimed too few rows on a shared dev DB |
| Checks | DB 105/105 · fresh replay of all 53 migrations ✓ · **end-to-end 191/191** · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ |

## U4 Registrar desk: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0051: visit_prescriptions, print_prescription (audited), reschedule_appointment | done |
| Token + receipt print page per visit; Print Rx page; Receipt and Print Rx links on the queue; Reschedule picker on today's appointments; dues panel with Collect; top-bar patient search (Admin → Patients, or the desk pre-filled); "rescheduled" email | done |
| Checks | DB 102/102 · fresh replay of all 51 migrations ✓ · **end-to-end 178/178** · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ |
| Fixed before use | the printed prescription read a non-existent "revoked" column for the doctor's registration (would have failed on first print); the reschedule picker took the UTC date |

## U3b Patients: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0050: patient_duplicate_candidates, clear_duplicate_flag | done |
| Admin Patients: search, newest, possible duplicates; patient page: details (edit), duplicate check with matches and "different people", visits, appointments, bills, owed + Collect | done |
| Checks | DB 100/100 · fresh replay of all 50 migrations ✓ · **end-to-end 165/165** · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ |
| Not yet | merging records (M-37, P2) |

## U3a Admin dashboard, Billing, Audit log: done (2026-11-21)
| Item | Status |
|---|---|
| Dashboard: money today from the accounts (services, pharmacy, cash and online received, owed by patients, owed to vendors) for finance/report holders; requests waiting, books check; live refresh; no demo data left anywhere | done |
| Admin Billing: bills of a period (OPD and pharmacy, filter), patients who owe with Collect; bill page shared with the pharmacy (components/billing/bill-view.tsx) with collect, return, void today | done |
| Audit log: grouped kinds, person, outcome, dates, 100 at a time; chart reads by patient number only | done |
| Fixed | a bill with a return showed "due" as total − paid; it now shows what is really owed |
| Checks | **end-to-end 151/151** · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ (no migration) |

## B9b Scheduled jobs: done (2026-11-21), Phase 0 complete
| Item | Status |
|---|---|
| Migration 0049: tenant_settings.reminder_hours_before; reminders queued on confirmation; mark_no_shows, daily_stock_scan, warn_subscriptions_ending, prune_sign_in_records, run_daily_jobs | done |
| /api/cron/daily (jobs + reconcile_all_tenants); stock and subscriptions routes accept Vercel's Bearer; vercel.json (dispatcher every 5 min, daily at 00:15 NPT) | done |
| Checks | DB 98/98 · fresh replay of all 49 migrations ✓ · **end-to-end 140/140** (purchasing → counter → returns → finance → reports → realtime/notifications → daily jobs) · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ |
| Not yet | a reminder setting on the Settings screen (default 24 h applies); real sends need a Resend key; Hobby-plan cron limit (D-119) |

## B9a Realtime & notifications: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0048: realtime_events (+emit_event, events_since), notifications, push_subscriptions, notification_outbox (+notify_members, queue_email, claim_outbox, complete_outbox, prune); triggers on appointments, visits, prescriptions, invoices, stock_balances | done |
| /api/realtime (short SSE, Last-Event-ID), LiveRefresh on Registrar, OPD and Pharmacy, bell with unread count in both areas, My notifications page, push on/off per device, /sw.js | done |
| /api/cron/dispatch-notifications (email via Resend or dry run; push via web-push 3.6.7); lib/cron.ts accepts x-cron-secret or Vercel's Bearer | done |
| Checks | DB 94/94 · fresh replay of all 48 migrations ✓ · **end-to-end 133/133** incl. a prescription arriving on the live stream within seconds with no patient data, booking request → admin, approve → queued email → dry-run skip, a real push attempt with retry · VAPID private key absent from client bundles · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ |
| Not yet | real email until a Resend key + verified domain; push tested end to end in a real browser; per-person notification preferences; push_shows_patient_name opt-in |

## B8b Reports: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0047: stock_report, batch_history, expiry_report, sales_register, item_sales, purchase_register, cash_book; stock_today callable by the app (fixes the B7b return page silently using the UTC date) | done |
| Admin Reports: tabs per permission, period / day / expiry window, store picker (store-scoped), cost columns only with view_cost_prices, totals; batch history page; Download CSV (A3, audited, formula-safe) | done |
| Checks | DB 90/90 · fresh replay of all 47 migrations ✓ · **end-to-end purchasing → counter → returns → finance → reports 112/112** · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ |
| Not yet | PDF/print layouts for reports; opening patient dues (D-109) |

## B8a Finance: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0046: expenses, other_income, finance_openings, finance_checks; record_expense, record_other_income, reverse_finance_entry, post_finance_opening; finance_range, account_balance, posting_reversed; finance_report, profit_and_loss, daily_summary; verify_finance_integrity; nightly job checks the books too | done |
| Admin Expenses (record, other income, cancel with reason, cancelled stay listed) and Finance (periods, day at a glance, P&L whole clinic or per store, balances start/end, money in and out by cause, online by channel, expenses by category, books check, opening cash and bank) | done |
| Checks | DB 87/87 · fresh replay of all 46 migrations ✓ · **end-to-end purchasing → counter → returns → finance 97/97**, books check clean across all of it · dev clinics pass the books check · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ |
| Not yet | opening patient dues (D-109); CSV exports (A3, with B8b reports) |

## B7b Returns, void, dues: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0045: sale_returns (+lines), invoice_outstanding, invoice_paid, business_day, patient_open_bills; post_sale_return, void_invoice, collect_patient_dues | done |
| Bill page: returns shown, Collect due, Return items, Void (today only); Return items page (per batch: shelf / quarantine / destroyed; refund or reduce due); Pharmacy Dues tab | done |
| Checks | DB 83/83 · fresh replay of all 45 migrations on an empty DB ✓ · **end-to-end purchasing + counter + returns 79/79**, incl. inventory = stock ledger, customers owe nothing, cash in the accounts = documents · all earlier journeys ✓ · typecheck/lint/build ✓ · posture ✓ |
| Not yet | the counter's credit-limit check counts bills before returns (stricter than needed); voiding/returning front-desk visit bills has no screen yet; printed refund receipt |

## B7a Pharmacy counter: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0044: external_prescriptions, invoice store/phone/outside-Rx, item lines (unit, base qty, cost, Rx item, substitution), invoice_line_allocations; issue_counter_sale; dispensing_queue | done |
| Pharmacy page (Employee): Dispense (queue with allergies, Dispense and bill), Sale (search, units, discount, batch preview earliest-expiry first, chosen batch, link patient, outside prescription, cash/online, dues), Bills (recent bills, stock alerts); store switch; printable bill | done |
| Checks | DB 80/80 · **end-to-end purchasing + counter 60/60**, incl. COGS = lot costs and inventory in the accounts = stock ledger · all earlier journeys pass · typecheck/lint/build ✓ · posture ✓ |
| Not yet (B7b) | voiding a bill, sales returns, collecting dues later; partial quantity of a single prescription item stays "dispensed"; barcode scan at the counter |

## B6b Purchase orders, returns, payable check: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0043: purchase_orders (+lines), bill lines/headers linked to orders, purchase_returns (+lines, +allocations), payable_reconciliations; po_line_received, po_refresh_status, create/end_purchase_order, post_purchase_return, reconcile_vendor_payables; post_purchase_invoice and void_purchase_invoice updated for orders; nightly job also checks payables | done |
| Purchase orders list/new/order page (ordered, received, still to come; receive a bill for it; cancel/close); order from Reorder suggestions | done |
| Returns list; Return to vendor (from a bill, a vendor or the menu): batches in a store bought from that vendor, quantity and reason per batch, credit note / cash / online refund | done |
| Vendors page: payables check (last result + Check now) | done |
| Checks | DB 76/76 · **purchasing end-to-end (B6a+B6b) 44/44** incl. accounts inventory = stock ledger and payables = documents · all earlier journeys pass · typecheck/lint/build ✓ · posture ✓ |
| Not yet | applying a vendor advance to a later bill; emailing a PO to the vendor (needs mail) |

## Super Admin: create a clinic directly: done (2026-11-21)
| Item | Status |
|---|---|
| Migration 0042: tenant_applications.source (website / direct), create_tenant_direct (records a direct application, provisions in one step, refuses an email already administering a live clinic, bad PAN, non-platform-admin) | done |
| Super Admin → Clinics → **Add a clinic**: clinic details, link (auto from name), admin name + email, plan, start, days, trial/paid/complimentary → one-time setup link + the clinic's sign-in address, copy buttons | done |
| `/not-live` page for staff of a pending clinic (fixes a redirect loop) | done |
| Checks | DB 72/72 · **end-to-end 22/22**: create → setup link → password + 2FA → sign in at /login/<clinic> → invite staff → staff waits until go-live → reaches the desk · all earlier journeys pass · typecheck/lint/build ✓ · posture ✓ |

## B6a Purchasing: done (2026-11-20)
| Item | Status |
|---|---|
| Migration 0041: vendors (+code counter), purchase_invoices (+lines; duplicate-bill unique index), vendor_payments (+allocations); FKs from lots and journal to vendors/purchase lines; save_vendor, vendor_balances, purchase_outstanding; post_vendor_opening, post_purchase_invoice, void_purchase_invoice, post_vendor_payment (ledger_writer, exposed) | done |
| Admin → Vendors (list with what's owed, add), vendor page (bills with what's still owed, account statement from the journal, pay, opening balance, details) | done |
| Admin → Purchases (list), Enter a bill (lines with free qty, discount, VAT, batch, expiry, MRP; bill discount; paid now / on credit), bill page (lines, lot cost, amounts, void) | done |
| Checks | DB 71/71 · **B6a end-to-end 20/20** (payable from accounts = from bills; inventory in accounts = stock ledger value) · all earlier journeys pass · typecheck/lint/build ✓ · posture ✓ |
| Also | CI fix: build without database access; CI bootstrap adds auth.users + pgcrypto (verified locally on PGlite: 40 migrations replay, posture, 65/66 DB tests) |
| Not yet | B6b; vendor advance applied to a later bill (stays as an advance for now) |

## B5c Alerts, suggestions, reconciliation: done (2026-11-20)
| Item | Status |
|---|---|
| Migration 0040: item_levels (store override), stock_alerts, purchase_suggestions, stock_reconciliations, reconcile_stock_balances, reconcile_all_tenants (ledger_writer, exposed) | done |
| "Needs attention" on each store's stock page; real stock alerts on the Admin dashboard (demo panel removed); Admin → Stock → Reorder (suggested purchases + ledger check) | done |
| `POST /api/cron/stock` nightly reconciliation (secret-gated; scheduling with hosting) | done |
| Checks | DB 66/66 · **inventory end-to-end (B5a+b+c) 52/52** incl. tampered balance repaired by the nightly job · all earlier journeys pass · typecheck/lint/build ✓ · posture ✓ |
| Not yet | editing per-store levels on screen (database supports it); alert notifications (B9) |

## B5b Stock operations: done (2026-11-20)
| Item | Status |
|---|---|
| Migrations 0035–0039: stock_transfers (+items, lines), stock_adjustments (+lines), stock_counts (+lines), stock_disposals (+lines), batch_status_history; request/decide/dispatch/receive_transfer, post_stock_adjustment, start/record/post/cancel count, set_batch_status, post_disposal (all ledger_writer, exposed in the posture allow-list) | done |
| Stock page: per-lot Adjust / Block-Recall-Unblock / To quarantine; Dispose panel on the quarantine store; Add a store | done |
| Transfers page (new transfer, approve/reject, send, receive with loss, cancel); Stock count page (blind count sheet, post/cancel) | done |
| Checks | DB 62/62 (transfers with transit loss, adjustments, counts during sales, block/recall, disposal, isolation) · **B5a+B5b end-to-end 46/46** (incl. accounts inventory = stock ledger value) · all earlier journeys pass · typecheck/lint/build ✓ · posture ✓ |
| Bugs found & fixed by the tests | permission check ran without rights to read permissions (0036); **every stock decrease failed** in the balance trigger (0037); over-draw not mapped to "not enough stock" (0038); nothing could be moved into quarantine (0039) |
| Not yet | B5c alerts/suggestions/reconciliation; partial transfer receipt; "found stock" screen (database supports it) |

## B5a Inventory core: done (2026-11-20)
| Item | Status |
|---|---|
| Migrations 0033–0034: item_categories, manufacturers, generics, inventory_items (+ code counter), medicine_details, item_units (one base, factor frozen once stocked), item_barcodes, store_item_levels, item_batches (+ price history), stock_movements (append-only), stock_balances (trigger, never negative), stock_openings + lines; save_item, post_opening_stock (ledger_writer, exposed), allocate_stock (FEFO, internal), stock_by_batch, store_access | done |
| Admin → Medicines: list with search, stock in packs ("2 box + 3 strip"), reorder/critical flags; add/edit item (medicine details, pack presets, units, barcodes, levels) | done |
| Admin → Stock & stores: per store, lots by earliest expiry with expired/near-expiry flags and cost value; opening stock entry; who works in the store (view/operate/manage) | done |
| Demo clinic: 6 medicines with opening stock (one expired, one near-expiry lot); pharmacy user manages Pharmacy | done |
| Checks | DB 57/57 (item master, opening stock + journal, never negative, FEFO, isolation) · **B5a end-to-end 16/16** · B1, B3, B4a, B4b, B4c journeys pass · typecheck/lint/build ✓ · posture ✓ |
| Bug found & fixed by the tests | ledger_writer couldn't read the opening header to answer a retry (0034) |
| Not yet | B5b/B5c; purchases (B6); sales/dispensing using allocate_stock (B7); linking prescription lines to items |

## B4c Website booking requests: done (2026-11-20, D-82, D-83)
| Item | Status |
|---|---|
| Migrations 0031–0032: requester fields on appointments (patient optional only for open/declined website requests), public_booking_slots, request_booking (always 'requested', holds the time, 5/IP/day, max open per phone/email), public_booking_status, cancel_booking_by_token, approve_booking_request (+ atomic "as new patient"), expire_booking_requests; booking_enabled on by default | done |
| Clinic page: "Book appointment" button + request form (doctor, day, time, name, phone or Gmail, age, sex, reason, consent, honeypot) → private status link (`/c/<slug>/booking/<token>`) with cancel | done |
| Staff: "Website booking requests" on the Registrar desk and Admin → Appointments: call/email links, approve (link a matching patient by phone, or register new), decline with a message the requester sees | done |
| Admin → Clinic website: "Take booking requests on the website" switch | done |
| Checks | DB 53/53 · **B4c end-to-end 22/22** · B1, B3, B4a, B4b journeys pass · typecheck/lint/build ✓ · posture ✓ |
| Bug found & fixed by the tests | a failed "approve as new patient" left a duplicate patient (0032) |
| Not yet | SMS/email to the requester (needs mail/SMS); CAPTCHA (needs keys); scheduled expiry job (hosting) — expiry runs when the list is opened |

## B4b Doctor: done (2026-11-20)
| Item | Status |
|---|---|
| Migrations 0027–0030: encounters, addenda, diagnoses, vitals, prescriptions + items + counter, care_access_grants; clinical_scope (C1–C6), clinical_check/guard, open_chart (audited, refusals logged), start/save/finalize_encounter, add_addendum, record_vitals, set_allergy, save/issue/cancel_prescription, discard draft, break_glass; immutability triggers; app role has no clinical table access | done |
| OPD page: allergies, vitals, consultation note, diagnoses (ICD-10 optional), prescription lines (frequency presets like 1-0-1), save draft, "Finalize, issue Rx and finish", earlier consultations with prescriptions and addenda | done |
| Checks | DB 48/48 (care matrix, lifecycle, break-glass, no direct table access, isolation) · **B4b end-to-end 22/22** · B1, B3, B4a journeys pass · typecheck/lint/build ✓ · posture ✓ |
| Bugs found & fixed by the tests | immutable trigger referenced a prescription column on encounters (0028); refused chart reads were never logged (0029) |
| Not yet | prescription print layout, break-glass button + admin review screen, referral/share grant screen, nurse workspace screen, pharmacist C7 (B7) |

## B4a Front desk: done (2026-11-20)
| Item | Status |
|---|---|
| Migrations 0022–0026: patients (+allergies, MRN counter/trigger, duplicate flag, search), appointments (exclusions, status guard), visits + token counters, invoices/lines, payments/allocations, book_appointment, set_appointment_status, move_visit, **check_in_visit** (ledger_writer posting RPC, exposed in the posture allow-list); fixes: duplicate flag, channel check, service check, patient column grants, short-MRN search, midnight slot wrap, send-back transition | done |
| Registrar desk: find/register patient, check in with fee (cash / online / mixed, discount, dues if allowed) → token ticket, book for later (slot picker), today's appointments (check in / cancel / no-show), every doctor's queue | done |
| Doctor OPD: own queue, call next, done, back to queue, current patient + allergies | done (notes in B4b) |
| Admin dashboard: real patient flow, OPD queues and OPD fees received (stock/pharmacy still demo) | done |
| Checks | typecheck ✓ lint ✓ build ✓ · unit 16/16 · DB 44/44 (incl. two-connection booking race, isolation) · posture ✓ · **B4a end-to-end 34/34** · B1 20/20 · B3 37/37 · no secrets in bundles |
| Not yet | refunds when a paid visit is cancelled (B7), checkout billing for `awaiting_billing` visits (B7), receipt/token print layout, editing patient details screen, no-show job (B9) |

## B3 Tenant setup: done (2026-11-20)
| Item | Status |
|---|---|
| Migrations 0018–0021: departments, services, doctor profiles/departments/services, OPD schedules + exceptions, available_slots, site settings/notices/FAQs, store members, public_clinic_profile, invite_member / reissue / set roles / set active, go_live_blockers + go_live, save_role, credential edit clears verification; invite_preview returns member_id | done |
| Admin: Settings (clinic, bill header, operations), Departments & services, Doctors & schedules (+ per-doctor weekly OPD, leave, 7-day preview), Staff & roles (invite links, roles, permission editor, registrations + verify), Clinic website; dashboard setup checklist + Go live | done |
| Super Admin: verify a clinic's registrations (P-30) on the clinic page | done |
| Public `/c/[slug]`: real data via public_clinic_profile only | done |
| Demo clinic: services, doctor profile + OPD, published site (`node scripts/seed-dev-setup.mjs`, no password changes) | done |
| Checks | typecheck ✓ lint ✓ build ✓ · unit 16/16 · DB 37/37 (incl. two-clinic isolation suite) · posture ✓ · **B3 end-to-end 37/37** · B1 e2e 20/20 · B2 e2e passes except the registration rate limit (5/IP/day) tripped by repeated test runs from localhost, working as designed |
| Bugs found & fixed by the tests | go_live_blockers array append (0019) |
| Not yet | booking against slots (B4), store-member screens (B5), logo/photo uploads, Nepali-language site content |

## B2 Platform: done (2026-11-20)
| Item | Status |
|---|---|
| Migrations 0014–0017: plans, subscription periods, platform invoices/payments/sequences, applications, invites, stores (Pharmacy + Quarantine), provision_tenant, accept/reissue invite, expiry job, status changes; plan features in effective_modules; chained paid-until; invite status columns | done |
| Marketing: `/register` (honeypot, rate limits, no email enumeration), live pricing from public plans | done |
| Super Admin: Applications (approve → one-time invite link / reject with reason), Clinics list + detail (subscription periods, invoices, payments, admin invite re-issue, status with reason), Plans; overview shows waiting registrations and platform activity | done |
| `/invite/[token]`: owner sets password → linked as clinic admin → 2FA step | done |
| `/api/cron/subscriptions` (secret-gated); `CRON_SECRET`, `NEXT_PUBLIC_APP_URL` added | done (not scheduled yet: hosting) |
| Demo clinic: demo plan + 1-year complimentary period, stores added | done |
| Checks | typecheck ✓ lint ✓ build ✓ · unit 16/16 · DB 30/30 · posture ✓ · **B2 end-to-end 35/35** (registration incl. honeypot/no-enumeration → Super Admin password+TOTP → plan → approve → invite → owner account → billing → status → cron) · B1 end-to-end 20/20 still passing · no secrets in client bundles |
| Bugs found & fixed by the tests | posture: platform_payments tenant key (0015); paid-until ignored renewals added in advance (0016); clinic page 500 on member_invites permission (0017); test-harness FormData encoding |
| Left in the dev DB by tests | closed clinics named "E2E test clinic … (safe to ignore)", inactive e2e plans, deactivated throwaway e2e operators |
| Not yet | email verification/emailed invites (needs mail), CAPTCHA (needs Turnstile keys), scheduled expiry job (needs hosting), clinic-admin "Go live" from the setup checklist (B3), support desk (P2) |

## B1 Identity & access: done (2026-11-20)
| Item | Status |
|---|---|
| Migrations 0009–0013: permission/module/template catalog (generated), members, roles, overrides, credentials, PINs, trusted devices, attempts, session assurance, functions (effective_permissions/modules, resolve_request_context, PIN, devices, lockout, credential verification), reserved slugs | done |
| Defaults: P-11 MFA (platform admin, clinic admin, doctors) · P-18 usernames (clinic link) · P-19 6-digit PIN · P-30 credential verifier | applied |
| P-23 PIN → session spike | proven, adopted (D-67) |
| Server: `lib/auth/{context,guards,session,hmac,shell-props}.ts`, `app/actions/staff-auth.ts` (password, MFA, PIN, step-up, set PIN, trust/revoke device, sign-out), `proxy.ts` (staff redirects + remembered clinic) | done |
| Screens wired: `/login`, `/login/[slug]` (trusted device → staff picker + PIN; else password), `/login/mfa`, `/login/verify`, `/employee/pin`, `/admin/devices`; Admin/Employee layouts guarded; sidebar and workspaces filtered by permissions | done |
| Dev seed: demo clinic `arogya-demo` (admin, registrar, doctor, pharmacy), credentials in gitignored `scripts/dev-users.local.json` | done |
| Checks | typecheck ✓ lint ✓ build ✓ · unit 16/16 (incl. TS↔SQL parity) · DB 22/22 · posture ✓ · **end-to-end against the running app 20/20** (wrong password, username rules, registrar/pharmacy sign-in and desks, admin/doctor held at 2FA, PIN picker only on trusted devices, wrong/right PIN, A1 cannot enter Admin or change PIN) · no secrets in client bundles |
| Not verified by me | completing the authenticator step for the clinic admin/doctor (needs a person with an authenticator app) and a visual check in a browser |
| Deferred | idle-lock screen UI (U-phase), admin screens for staff/roles/credentials (U3 on B3), notification of other admins on credential changes (needs B9 notifications), clean empty-DB replay since 0008 (CI job not run yet) |

## Super Admin sign-in + dashboard: first real B1/U2 slice (2026-11-20)
| Item | Status |
|---|---|
| `platform_admins` (migration 0008) + `scripts/create-platform-admin.mjs` | done; Super Admin `cmedicare@gmail.com` exists on dev |
| `proxy.ts` (session refresh, signed-out redirect only), `lib/supabase/{server,service}.ts`, `lib/auth/{current-user,guards}.ts`, `lib/audit.ts` | done |
| L1 flow: `/superadmin/login` (password; non-admins get the same generic error and are signed out) → `/superadmin/login/mfa` (first time: QR enrolment; then 6-digit code) → aal2 → `/superadmin` | done; every step audited (`auth.superadmin_*`) |
| Guard `requireSuperAdmin()` = session + active platform_admins row (live) + aal2, in the layout and every page | done |
| Dashboard `/superadmin`: real clinic counts/list (empty state until B2), platform activity from audit_log, platform facts. No tenant patient/stock/money data (D-08) | done |
| Sign out (local scope) | done |
| Checks | typecheck ✓ lint ✓ build ✓ unit 10/10 ✓ DB 13/13 ✓ posture ✓ · signed-out redirects ✓ · MFA probe on the dev project (password → aal1 → TOTP → aal2, wrong code rejected; ES256 tokens verified locally) ✓ · no secret key in client bundles ✓ |
| **Not yet verified** | the full click-through in a browser (Chrome cannot reach localhost from this setup). Owner to sign in at `/superadmin/login` with an authenticator app ready |
| Not yet built | app-level lockout (Supabase Auth's own rate limit applies), account recovery for platform admins, IP allow-list (P-32), clinic approval/provisioning (B2) |

## U1 Design system & shells: status (2026-11-20)
| Item | Status |
|---|---|
| Tokens, Mukta typeface, focus/reduced-motion floor (`app/globals.css`, `app/layout.tsx`) | done |
| Primitives: Button, StatusChip, PageHeader, Panel, DemoNotice, AllergyBanner, Icon; **OPD ticket** | done |
| Shells: Admin (sidebar), Employee (workspace tabs + phone bottom bar), Super Admin (ink bar), tenant bar | done |
| Screens (demo data, inert forms): marketing landing · `/login` · `/login/[slug]` (trusted-device staff picker + 6-digit PIN pad, or password) · Admin dashboard (+ every menu item routed) · Registrar desk (register → OPD fee → token) · Doctor OPD (queue + consultation + e-Rx) · Pharmacy (dispensing queue + stock alerts) · Lab (Phase 3 note) · Super Admin clinics · public clinic site `/c/arogya-demo` | done |
| Checks | typecheck ✓ · lint ✓ · build ✓ (14 routes) · HTTP smoke test of every route ✓ |
| **Visual review in a browser** | **not done**: Chrome showed an error page for localhost:3000 although the server answered 200. Owner to review at `http://localhost:3000`, plus a phone-width check |
| Next in Phase 1 | owner feedback on the look → U3 Admin screens / U4–U6 desks as their backend milestones land; B1 sign-in is needed before any real screen |

## Status
- Project folder `Downloads/CMediSewa` (git remote `github.com/sanjib001/CMediSewa`).
  HRestroSewa was read only and never modified. Nothing is committed (the owner drives git).
- Revisions:
  - **R1:** analysis.
  - **R2:** five areas, dual auth, roles, website, patient accounts.
  - **R3:** inventory, pharmacy and finance.
  - **R4:** integration audit.
  - **R5:** owner answers on staffing, dashboards and phases.
- **Revision 5 owner decisions (Accepted):**
  - every clinic has its own pharmacy;
  - dashboards: **Admin, Registrar, Doctor OPD, Pharmacy**, with **Lab in Phase 3**;
  - the Pharmacy person = pharmacist + cashier + stock manager;
  - **one PAN / one bill series**, and billing is done by permitted staff;
  - the **OPD fee is taken at registration** by the registrar;
  - **Phase 0 = database + backend**, **Phase 1 = UI outline + MVP**, Phase 2 = next features,
    **Phase 3 = lab**.
  - Recorded as D-55 to D-58. This resolved P-17, P-21, P-29 and P-31. D-54 was superseded
    (the old MS/R1/R2/Gate labels are retired).
- Decisions D-01…D-59 (D-59: one host, owner) · pending P-01…P-32 (resolved: P-06, P-17, P-21, P-29, P-31) · modules
  M-01…M-52 · workflows W-01…W-36 · milestones B0–B9 (Phase 0), U1–U8 (Phase 1).

## Phase 0 plan (from `roadmap.md`)
B0 Foundation → B1 Identity & access → B2 Platform → B3 Tenant setup → B4 Clinical ops (incl.
registration + OPD fee) → B5 Inventory → B6 Purchasing → B7 Sales & billing → B8 Finance &
reports → B9 Realtime/notifications/jobs. Exit: every MVP workflow (W-31 as an executable
script) passes through actions/RPCs in automated tests on staging.

### B0 Foundation: status (2026-11-20)
| # | Task | Status | Evidence |
|---|---|---|---|
| 1 | Next.js scaffold (pinned, TS strict), five route groups on one host | **done** | `npm run build` passes; routes `/`, `/c/[slug]`, `/login`, `/admin`, `/employee`, `/superadmin` (placeholders) |
| 2 | Migration runner (dev/staging/prod interlocks via `APP_ENV`, dev-only `reset`) | **done** | `scripts/migrate.mjs`, `scripts/lib/db.mjs` |
| 3 | 0001 access posture | **done** | + 0006 (posture check found TRUNCATE/TRIGGER/REFERENCES/MAINTAIN on service_role) |
| 4 | Tenancy core: tenants, billing_profiles, tenant_settings, tenant_modules, audit_log (append-only) | **done** | migration 0003 |
| 5 | Posting core: postings, document_sequences, ledger_accounts (auto-seeded), ledger_entries, balance trigger, `ledger_writer`, reversals | **done** | migrations 0005 + 0007 (fixed an ambiguous-column bug the tests caught) |
| 6 | `lib/clinic-time.ts` (Kathmandu time, BS, fiscal year, business day), `lib/modules.ts`, fiscal calendar 0004 | **done** | generated by `scripts/gen-fiscal-calendar.mjs`, cross-checked between two libraries |
| 7 | Checks | **done locally** | lint ✓ · typecheck ✓ · unit tests 10/10 ✓ · DB tests 13/13 ✓ · posture ✓ · **full replay from an empty dev schema ✓** |
| 7b | CI workflow (`.github/workflows/ci.yml`): static job + empty-Postgres replay job | **written, not yet run** | needs a push to GitHub (no Docker on this machine to try the DB job locally) |
| 7c | Staging on Coolify | **blocked** | P-02 hosting / P-09 residency |
| — | `proxy.ts` session refresh, Supabase SSR clients | moved to **B1** | they belong with auth |

**Dev database:** hosted Supabase project in `.env.local` (Postgres 17.12, direct IPv4
connection works). `.env.local` holds only APP_ENV, the URL, publishable key, secret key and
DB URL. Duplicates and the derivable JWKS URL were removed, and the password is now
URL-encoded. The file is gitignored.

**Next: B1 Identity & access.** Supabase SSR clients + `proxy.ts`, invites, email/password,
Super Admin TOTP, `platform_admins`, `tenant_members`, roles/permissions engine with the
TS/SQL parity test, `session_assurance` + `resolve_request_context`, then the **P-23 spike**
(server-side session after PIN) before trusted devices and PIN. Needs P-11, P-18, P-19, P-30.

## Decisions still needing the owner
**Before B0 starts:**
- approve the architecture (D-01…D-59), especially D-06 (admin has no automatic clinical
  access), D-27 (email/password + PIN), D-38 (stock balance cache), D-43 (finance journal)
  and D-55 (backend-first phases);
- **P-26** finance engine: B0 built the journal (D-43) as recommended; say so if you want the pure-derivation alternative instead;
- **P-09/P-02** data residency and hosting (needed for staging and prod planning, not
  for local B0 work).

**Before B1:**
- **P-11** 2FA scope;
- **P-18** usernames for staff without email;
- **P-19** PIN length (6 recommended);
- **P-30** who verifies credentials in a single-admin clinic;
- P-23 is decided by the B1 spike.

**Before B3–B4:**
- **P-03** slots vs tokens;
- **P-07** admin clinical access / doctor history window;
- **P-20** patient OTP channel;
- **P-32** Super Admin IP allow-list.

**Before B5–B7:**
- P-24 drug master;
- P-25 price above MRP;
- P-28 restocking returns.

**Before go-live (legal):**
- P-08 tax and IRD;
- P-10 retention and consent;
- P-14 pricing;
- P-22 drug rules, including whether the Pharmacy person must hold a pharmacist
  registration;
- P-27 tax on medicines and services.

**Later:** P-01 domain (needed by staging/U2), P-04, P-05, P-12, P-13, P-15, P-16.

## Open questions for the owner
- Does the clinic use time slots or daily tokens for each doctor (P-03)?
- Is the pharmacy person a registered pharmacist (affects the credential gate on dispensing,
  P-22)?
- Should the GitHub repo be private?
