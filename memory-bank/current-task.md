# Current Task

**Phase:** Phase 0 complete. **Phase 1 in progress:** U3 Admin done (U3a + U3b). Next from the Phase 1 review: **U4 registrar gaps** (top-bar patient search, dues at the desk, print receipt/token/Rx, reschedule).
**Last updated:** 2026-11-20

## Phase 1 review (2026-11-21)
What each U milestone asks for (roadmap) against what the B milestones already built.
| Milestone | Already there | Still to do |
|---|---|---|
| U2 Marketing + Super Admin | landing, registration, applications, clinics (+ direct creation), plans | pricing from published plans and a contact page; Super Admin **Audit**, **Settings**, platform billing view, monitoring |
| U3 Admin | setup + go-live, settings, staff/roles/devices, services, doctors/schedules, website, appointments, medicines, stock, purchases, vendors, expenses, finance, reports; **U3a: dashboard on real data, Billing, Audit log** ~~Patients~~ (U3b done; merging is P2, M-37); reminder hours on Settings |
| U4 Registrar | today's board, register/search, book, check-in with OPD fee + token, queue, booking requests, live refresh | the top-bar patient search isn't wired; dues collection at the desk; print OPD receipt/token and Rx; reschedule from the desk |
| U5 Doctor OPD | queue, call next, chart + allergies, consultation, e-Rx → pharmacy queue, live refresh | follow-up booking from the consultation; **my schedule and leave** (manage_own_leave exists, no leave data yet: needs a migration) |
| U6 Pharmacy | dispensing queue, sale (FEFO, units, batch choice), bills, returns, void, dues, stock alerts, live refresh | barcode scan at the counter; stock tasks reachable from the pharmacy workspace for staff without Admin |
| U7 Public site | site, doctors, services, slots, booking requests, status link | optional patient account; manage link in patient emails |
| U8 PWA & polish | push opt-in, service worker | web app manifest + icons, install, offline gate, iOS standalone sign-in, idle lock, print layouts (OPD bill, token, Rx, GRN) |

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
