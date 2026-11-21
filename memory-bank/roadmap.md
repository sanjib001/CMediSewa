# Roadmap

Status: **Owner-directed phase structure** (Revision 5, 2026-11-20). Dates are not
committed. Each milestone has exit criteria, and nothing starts before its foundations are
green.

| Phase | Scope | Owner direction |
|---|---|---|
| **Phase 0** | **Database + backend first**: schema, migrations, RPCs, Server Actions, auth backend, permissions engine, posting core, background jobs, automated tests. No product UI | "in phase 0 let's set the database and backend first" |
| **Phase 1** | **Initial outline (UI) + MVP**: the five areas and four staff dashboards (Admin, Registrar, Doctor OPD, Pharmacy) built on the Phase 0 backend; pilot go-live | "in phase 1 the initial outline and MVP of the system" |
| **Phase 2** | Next features after the pilot (online documents, online payments, controlled-drug register…) | "then we will move on" |
| **Phase 3** | **Laboratory** + Lab dashboard (+ clinical files) | "we will work on lab in phase 3" |
| Future | insurance, multi-branch, telemedicine… | — |
Older labels: "R1/R2", "MS0–MS13" and "Gate A/B" from Revision 4 are **retired**. Every
clinic has its own pharmacy, so there is one pilot gate at the end of Phase 1 (P-17
resolved). The posting core is still built first (D-53).

## Dependency graph
```
PHASE 0 (backend)
 B0 Foundation ─► B1 Identity & access ─► B2 Platform ─► B3 Tenant setup ─┬─► B4 Clinical operations ─┐
                                                                         └─► B5 Inventory ─► B6 Purchasing ┤
                                                                                                           ▼
                                                                         B7 Sales & billing ─► B8 Finance & reports
 B9 Realtime, notifications & jobs (after B4; done before Phase 1 ends)
PHASE 1 (UI + MVP)
 U1 Design system & shells ─► U2 Marketing + Super Admin ─► U3 Admin dashboard ─┬─► U4 Registrar dashboard ─┐
                                                                               ├─► U5 Doctor OPD dashboard ─┤─► U8 PWA & polish ─► PILOT
                                                                               ├─► U6 Pharmacy dashboard ───┤
                                                                               └─► U7 Public clinic website ┘
PHASE 2 ─► PHASE 3 (Lab) ─► Future
```

## Phase 0: database & backend
Every milestone is delivered as migrations + RPCs + Server Actions + **automated tests that
drive the real workflows without UI**. `workflows.md` W-31 becomes an executable end-to-end
test script. This is how Phase 0 avoids building a backend the UI later can't use (D-55).

| # | Milestone | Contents | Exit criteria |
|---|---|---|---|
| **B0** | Foundation | Next.js skeleton (pinned) with the five empty route groups on one host; Supabase local; **migration 0001 access posture**; migration runner (dev/staging/prod interlocks); `tenants`, `tenant_settings`, `billing_profiles`, `tenant_modules`, `audit_log`; composite-FK lint; `lib/modules.ts`; `lib/clinic-time.ts` (Asia/Kathmandu, BS, fiscal year); **posting core** (`postings`, `document_sequences`, `ledger_accounts`, `ledger_entries`, balance trigger, `ledger_writer` role); CI (replay, posture, ledger guard, bundle scan); staging | fresh DB replays; posture + ledger-guard tests green; deploys to staging |
| **B1** | Identity & access | email/password + invites + recovery; Super Admin TOTP; MFA; lockout; `session_assurance`; `resolve_request_context`; guards + step-up; permissions engine (keys, role templates, custom roles, overrides, credentials with independent verification, business type/module filters, **store scope**); TS/SQL parity; **P-23 spike** → trusted devices, PIN verify/lockout, idle lock, switch user (server side) | auth integration tests; operation × assurance matrix; PIN never reaches A2 operations |
| **B2** | Platform | applications → verification → approve → `provision_tenant` (settings, one billing profile, role templates, **Pharmacy + quarantine stores**, modules on, subscription, admin invite); plans, subscriptions, platform invoices/payments, expiry cron | application → tenant test; Super Admin negative suite |
| **B3** | Tenant setup | settings actions; staff, roles, credentials, store assignment, devices; departments, services (OPD fee services), doctors, schedules, `available_slots()`; website content model + publish; stores | **two-tenant isolation suite** established and run on every later milestone |
| **B4** | Clinical operations | patients (MRN, duplicates); appointments (GiST exclusion, status machine); public booking RPC + manage token + OTP patient accounts; **registration/check-in with the OPD fee invoice + payment** (`consultation_billing_point = check_in`); tokens/queue; encounters with the care predicate + audited reads; prescriptions | booking concurrency; public contract; care-matrix tests |
| **B5** | Inventory | item master, units, barcodes, lots, movements → balances (CHECK ≥ 0), `allocate()` FEFO, opening stock, transfers, adjustments, counts, quarantine, disposal, block, alerts, suggestions, reconciliation | stock concurrency; expired never allocated; reconciliation catches tampering |
| **B6** | Purchasing | vendors, PO, purchase invoices (lots), returns, vendor payments + allocations, vendor ledger | payable = documents = journal; duplicate bill refused |
| **B7** | Sales & billing | invoices (services + items), allocations, payments (cash/online/mixed), dues, returns, void, dispensing (Rx link, partial, substitution), external Rx, controlled items blocked | Σ allocations = qty; COGS = Σ lot cost; **W-31 end-to-end script passes** |
| **B8** | Finance & reports | expenses, other income, openings, `finance_report`, P&L, daily summary, stock/expiry/purchase/vendor/sales reports | opening(T) = closing(T−1); finance integrity green |
| **B9** | Realtime, notifications & jobs | SSE bus; outbox + dispatch cron (email); web-push backend; expiry/low-stock/no-show/subscription jobs | exactly-once delivery; PHI-free payloads |
**Phase 0 exit:** every MVP workflow runs end to end through actions/RPCs in automated tests
on staging.

## Phase 1: initial outline (UI) & MVP
| # | Milestone | Contents | Exit criteria |
|---|---|---|---|
| **U1** | Design system & shells | tokens, components (`ui-ux.md` §10), five area layouts, sign-in screens (L1–L9), lock screen, step-up dialog, store switcher | clickable outline of every area |
| **U2** | Marketing + Super Admin | landing, pricing, registration, contact; Super Admin applications, tenants, plans, billing, monitoring | onboarding E2E in the browser |
| **U3** | **Admin dashboard** | setup checklist + go-live; profile/branding/settings; staff, roles, devices; departments, services, doctors, schedules; website manager; patients; appointments overview; inventory (items, stores, stock, transfers, counts); vendors and purchases; billing; expenses; finance; reports; audit | admin can configure a pilot clinic completely |
| **U4** | **Registrar dashboard** | today's appointments, register/search patient, book/reschedule/cancel, **check-in with OPD fee bill + receipt + token**, queue board, collections/dues, print Rx, all other entries as permitted | front-desk day E2E |
| **U5** | **Doctor OPD dashboard** | my queue, call next, patient summary + allergy banner, consultation, e-prescription (catalogue items) → pharmacy queue, follow-up, my schedule/leave | consultation → Rx E2E |
| **U6** | **Pharmacy dashboard** | dispensing queue, OTC sale (scan/search, units, FEFO lots), pharmacy billing + payments + returns, stock (receive, transfers, counts, adjustments, expiry/quarantine), purchases and vendors (as permitted), low-stock/near-expiry alerts | dispense → bill → stock deducted E2E |
| **U7** | Public clinic website | tenant-themed site, doctors, services, slots, booking, status, manage link, optional patient account | booking from phone E2E |
| **U8** | PWA & polish | install, push opt-in, offline gate, iOS standalone sign-in, print layouts (OPD bill, pharmacy bill, Rx, token, GRN) | pilot readiness checklist |
**Pilot gate (end of Phase 1):** W-31 passes in the browser; prod stack ready (P-02, P-09);
backups + PITR + off-site; restore drill; monitoring; security review; counsel opinion on
`security.md` §10–§11. Then go-live and 2–4 weeks of stabilisation.

## Phase 2: next features (order follows pilot feedback)
M-33 patient documents online · M-34 online payments · M-46
purchase suggestions & supplier performance · M-45 reservations · M-52 patient advances ·
M-35 follow-ups/referrals · M-36 daily summary email · M-37 patient merge · M-49 advanced
barcode · M-51 bulk recall · M-06 support desk · M-38 instant self-serve · M-39 subdomain
sites · Nepali UI.

## Phase 3: laboratory
M-30 lab (test catalogue, orders from OPD, samples, results, report PDF, lab billing through
the same invoice pipeline) · **Lab dashboard** (worklist, sample status, result entry,
verification) · M-31 clinical files (private storage, signed URLs). Needs B4 (encounters),
B7 (billing) and the Phase 1 dashboards.

## Future
M-40 insurance (HIB/SSF) · M-41 multi-branch · M-42 telemedicine · M-43 interoperability ·
M-44 payroll & attendance · M-50 accounting export / e-billing · custom domains.

## Testing approach (cumulative; each suite runs on every later milestone)
Posture + ledger guard (B0) · auth + assurance (B1) · Super Admin negative (B2) · two-tenant
isolation (B3+) · booking concurrency + public contract + care matrix (B4) · stock
concurrency + reconciliation (B5) · payable integrity (B6) · allocation/COGS + **W-31
script** (B7) · finance integrity (B8) · PHI-free notifications (B9) · browser E2E per
dashboard (U2–U7).

## Risks
- **Backend before UI (D-55):** endpoints may not fit the screens. Mitigation: workflows
  drive the API, executable workflow tests, and the U1 clickable outline early in Phase 1,
  with B-milestone fixes allowed.
- P-23 (PIN sessions) is the riskiest unknown, with the fallback of PIN-as-unlock only.
- Legal answers (P-08, P-09, P-10, P-22, P-27) can change invoicing, dispensing and hosting.
- Doctors' acceptance of the care-access and assurance rules, to be tested in U5 with the
  pilot doctor.
