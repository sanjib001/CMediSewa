# Architecture

Status: **Recommendation** (Revision 4, 2026-11-20: integration audit; §2a lifecycle, §2b
module registry, §2c clinic↔pharmacy journey, §6a final login flows). Reasons are in `decisions.md`. The
HRestroSewa patterns referenced here are verified in `../docs/hrestrosewa-reference.md`.

## 1. System overview
```
 Prospects      Patients            Employees / Admin (PWA)                  Super Admin
     │              │                        │                                     │
     ▼              ▼                        ▼                                     ▼
 ┌────────────────────────────── Next.js app (one deployment, Node runtime) ────────────────────┐
 │ proxy.ts: session refresh + redirect only (never authorizes). ONE host, as in HRestroSewa (D-59)│
 │ <domain>/          (marketing)                         <domain>/login, /login/[slug]  (auth)    │
 │ <domain>/c/[slug]  (public) tenant website + booking                                            │
 │                    patient session: cm_patient cookie   (admin)/admin/*  (employee)/employee/*  │
 │                                                          (superadmin)/superadmin/*              │
 │ Server Components (reads) + Server Actions (the API):                                          │
 │   app/actions/*  (tenant)   app/actions/public/*  (public site)   app/actions/platform/*        │
 │ lib: auth/ (guards, assurance, trusted devices, PIN) · permissions · care-access · audit        │
 │      scheduling · inventory · billing · finance · notify · realtime · clinic-time              │
 │ app/api: realtime (SSE) · cron/* · push/action · files/[id] · health                           │
 └──────────────┬────────────────────────────────────┬────────────────────────────┬──────────────┘
                │ service_role (server-only)          │ LISTEN cm_events            │ HTTPS
                ▼                                     ▼                             ▼
 ┌──────── Self-hosted Supabase (Coolify) ─────────────────┐            Resend · SMS (P-05)
 │ Postgres: RLS on, no anon/authenticated grants           │            web-push services
 │   RPCs: booking, check-in, clinical (care check + audit),│
 │         PIN verify + lockout, purchase, sale, transfer,  │
 │         invoice issue, finance_report, stock_report      │
 │   pg_cron + pg_net → /api/cron/*  (Vault secrets)        │
 │ Auth: email+password (all internal users), TOTP MFA      │
 │ Storage: public-assets (logos, site media, doctor photos)│
 │          clinical-files (private, signed URLs; P2)       │
 └──────────────────────────────────────────────────────────┘
```

## 2. The five application areas
HRestroSewa separates `(marketing)`, `(superadmin)`, `(admin)`, `(employee)` and
`(customer)/c/[slug]` inside one Next app. CMediSewa keeps that shape (D-28):

| Area | Route group | Layout guard | Content |
|---|---|---|---|
| Marketing | `(marketing)` | none (static/ISR) | landing, features, pricing (from `plans.is_public`), register, contact, legal |
| Super Admin | `(superadmin)/superadmin/*` | `requireSuperAdmin()` at A3 | tenants, applications, plans, platform billing, monitoring, settings, support |
| Admin | `(admin)/admin/*` | `requireTenantMember()` at A2 or above; **each page guards its own permission** (HRestroSewa: "layout admits any active staff; each page guards") | back-office: setup, website, employees/roles, doctors, patients, appointments, inventory, stores, vendors/purchases, billing, expenses/finance, reports, settings |
| Employee | `(employee)/employee/*` | `requireTenantMember()` at A1 or above; pages guard permission **and** the required assurance level | four role workspaces (D-56): **Registrar** (registration + OPD fee, appointments, queue), **Doctor OPD** (queue, consultation, e-Rx), **Pharmacy** (dispensing, sales, billing, stock, purchases), **Lab** (Phase 3); plus my schedule, notifications |
| Client / Patient | `(public)/c/[slug]/*` | none / patient session | tenant website, doctors, services, slots, booking, booking status, optional patient account |

- **Shared client components, not duplicated screens.** As in HRestroSewa (`StockClient`,
  `VendorsClient` used by both trees), each feature has one client component. Admin pages
  show the full management view, and employee pages are thin wrappers that pass a reduced
  mode.
- **Landing after sign-in:** Admin → `/admin/dashboard`. An employee goes to the home of
  their primary role (`roles.home_route`: `/employee/registrar`, `/employee/opd`,
  `/employee/pharmacy`, `/employee/lab` in Phase 3; D-56). An employee holding management permissions
  also sees an "Admin" switch, which needs A2.
- **Navigation is derived from permissions and business type** (`getAdminNav(ctx)`,
  `getEmployeeNav(ctx)`), so the menu always matches what the guards allow.

## 2a. How the five areas connect: the tenant lifecycle (Revision 4)
```
 (marketing)            (superadmin)                 (admin)                   (employee)          (public)/c/[slug]
 Register form ──► tenant_applications ──► approve ──► provision_tenant ──► setup checklist ──► daily operations ──► patients book
   W-01 step 1      (email verified)        W-01 §3     tenants, settings,   W-02: profile,      W-05 PIN on trusted   W-08 booking,
                                                         billing profile,     billing profiles,   devices; W-10–W-16   account, status
                                                         roles, stores,       modules, roles,     front desk, doctor,
                                                         subscription,        staff, doctors,     pharmacy, cashier,
                                                         admin invite         stores, items,      stock
                                                                              website publish
        ▲                      │ monitors (counts only), bills the tenant (platform_invoices),
        └──── pricing page ◄── plans                  │ suspends on expiry (W-33), never sees patient/stock/money detail
```
| Stage | Area | Tenant status | What unlocks |
|---|---|---|---|
| 1. Registration | Marketing | — (application) | nothing. The application is not a tenant |
| 2. Approval and provisioning | Super Admin | `pending` | the admin invite. Admin area in setup mode (setup checklist only) |
| 3. Setup | Admin | `pending` | the required checklist items (profile, billing profile, ≥1 role and staff member, and per enabled module: ≥1 doctor + schedule, ≥1 store + items). Then "Go live" (A2 + re-auth) → `active` |
| 4. Go-live | Admin | `active` | Employee area for all members; trusted devices; the public site can be published (if booking is enabled) |
| 5. Production | all | `active` | subscription periods are billed by the Super Admin. Expiry → `suspended` (W-33) |
| 6. Suspension / closure | Super Admin | `suspended` / `closed` | suspended: read-only Admin (export allowed), Employee and public booking off. Closed: data export, then retention (P-10) |

## 2b. Optional modules: the module registry (D-50)
Not every tenant runs a pharmacy, lab or stores. `lib/modules.ts` is the **single source**
for modules, the way `lib/permissions.ts` is for permissions:
`{ key, requires: { business_types, plan_feature?, modules[] }, permissions[], nav[],
default_on }`.
**Effective module** = business type allows it **∧** the plan includes it **∧** the tenant
admin has it **enabled** (`tenant_modules`) **∧** its required modules are enabled.
| Module | Requires | Default |
|---|---|---|
| `appointments` (+ public booking) | BT clinic/clinic_pharmacy | on |
| `consultation` (encounters, Rx) | `appointments` | on |
| `inventory` (items, lots, stores, ledger) | any BT | on for clinic_pharmacy/pharmacy; **off** for clinic (turn on to track clinic consumables) |
| `purchasing` | `inventory` | follows inventory |
| `pharmacy_counter` (dispensing, OTC) | `inventory` ∧ BT with pharmacy | on for pharmacy BTs |
| `lab` (P2) | `consultation` ∧ plan `lab` | off |
| `expenses_finance` | — | on |
| `website` | — | on |
An off module is **not navigable, not grantable and not postable**. Its actions refuse with
`MODULE_DISABLED`, the HRestroSewa `hasRooms` rule generalised. Turning a module off never
deletes data; turning it back on restores access. Effects: without `pharmacy_counter`, an Rx
is printed and its items are free text, with no dispensing queue. Without `inventory`,
invoices hold service lines only. Without `appointments` (pharmacy-only), patients are
customers and prescriptions are external.

## 2c. Clinic ↔ pharmacy integration: one journey, one record per fact (D-49, D-51)
```
Patient (public site)        Receptionist (A1)         Doctor (A2)              Pharmacist (A1)            Cashier / system
  book_appointment ──────► appointment confirmed
  (patient matched/created)  check_in → visit + token
                             [fee at check-in? → OPD invoice, services profile]
                                                       open_encounter (C1)
                                                       finalize_encounter
                                                       issue_prescription ──► dispensing queue (C7)
                                                                              allocate FEFO in pharmacy store
                                                                              issue_invoice (pharmacy profile,
                                                                               store = pharmacy, lines → Rx items)
                             checkout: services invoice (if fee at checkout) ──────────────────────► record_payment
                                                                                                    → journal, reports, SSE,
                                                                                                      notifications
```
**Single source per fact (no duplicated data):**
| Fact | Owned by | Referenced (never copied) by |
|---|---|---|
| Who the patient is | `patients` | appointments, visits, encounters, prescriptions, invoices, payments, patient_account_links |
| The booking | `appointments` | visit (`appointment_id`), notifications |
| That they came today | `visits` | encounter, services invoice, queue |
| What the doctor found | `encounters` (+ vitals, diagnoses) | prescription |
| What was prescribed | `prescription_items` | invoice lines (`prescription_item_id`), dispensations. **Dispensed qty is derived** (Σ linked lines) |
| What stock left which store | `stock_movements` (via allocations) | stock_balances (cache), reports |
| What was charged | `invoices`/`invoice_lines` | payments (via allocations), journal |
| What money moved | `payments` / `vendor_payments` / `expenses` | journal |
| The financial effect | `ledger_entries` | reports |
**Linking rules:**
- **One invoice = one billing profile (+ at most one store).** A visit can therefore have a
  **services invoice** (clinic profile) and a **pharmacy invoice** (pharmacy profile).
  Clinics and their pharmacies often have separate registrations and PAN in Nepal
  (**owner, D-58: this clinic model uses one PAN, so both invoices share one profile and series**; a second profile stays possible). Both invoices reference the same `visit_id` and `patient_id`, and
  the patient's statement shows both.
- **Consultation fee timing** is a tenant setting (`consultation_billing_point`: `check_in`
  (prepaid OPD ticket, **the owner-chosen default**, D-58) | `checkout` | `none`). The
  services invoice is created by the check-in or checkout RPC, never by hand-copying
  appointment data.
- **Dispensing never re-enters the prescription.** Invoice lines point at
  `prescription_items`. A partial dispense leaves a derived remainder in the queue. A
  substitution records the reason.
- **Stock leaves the invoice's store only**, through allocations, inside `issue_invoice`.
- **Money and stock are posted in the same transaction** as the document (§9.3), so the
  invoice, the movements and the journal are either all there or none.
- **In-clinic administered items** (an injection given in the procedure room, dressing
  materials) are item lines on the **services** invoice from the procedure/department store,
  or an `internal_use` adjustment when not billed (W-32).

## 3. Frontend architecture
- One Next.js App Router app (D-01). Server Components fetch data. Client Components handle
  interaction, call Server Actions again and listen to `useRealtime`.
- UI kit: Tailwind v4 tokens + radix primitives, copied from HRestroSewa `components/ui`
  and restyled (`ui-ux.md`).
- The public site imports nothing from `(admin)`/`(employee)`, ships minimal JS and uses its
  own theme driven by the tenant's website settings.
- **i18n-ready** (P-13). Dates are stored in UTC, shown in Asia/Kathmandu, with AD and BS
  where patients or printouts see them. All date maths lives in `lib/clinic-time.ts`
  (HRestroSewa's `business-day.ts` rule, including a configurable day-closing hour for
  finance, D-14).

## 4. Backend architecture
Every Server Action:
1. resolves the caller with **one** context lookup (`getTenantContext()`, memoised per
   request). This is a single RPC `resolve_request_context(auth_user_id, session_id)`
   returning membership, tenant status, subscription validity, effective permissions and
   session assurance in one round trip (HRestroSewa's lesson that latency is round trips);
2. checks the **capability permission** and the **minimum assurance level** for the
   operation (`permissions.md` §3);
3. for patient clinical data, uses a clinical RPC that checks the **care relationship** in
   SQL and writes `audit_log` in the same transaction;
4. scopes every query by `ctx.tenant_id` through the `db(ctx)` helper;
5. audits sensitive writes.

**RPCs** handle everything atomic: `book_appointment`, `check_in`, `open_encounter`,
`finalize_encounter`, `issue_prescription`, `verify_pin` (lockout), and every stock or money
**posting** through one pipeline (§9.3): `issue_invoice`, `record_payment`,
`post_sale_return`, `void_invoice`, `post_purchase_invoice`, `post_purchase_return`,
`record_vendor_payment`, `dispatch_transfer`/`receive_transfer`, `post_stock_adjustment`,
`post_stock_count`, `post_disposal`, `post_opening_stock`, `record_expense`. Reports are SQL
functions (`stock_report`, `finance_report`, `profit_and_loss`…). RPCs are granted to
`service_role` only and raise bare error codes (`SLOT_TAKEN`, `INSUFFICIENT_STOCK`,
`BATCH_EXPIRED`, `BATCH_BLOCKED`, `RX_REQUIRED`, `DUPLICATE_VENDOR_INVOICE`, `PIN_LOCKED`).

**Derived, not stored** (HRestroSewa rule): vendor payables, patient dues, invoice
outstanding, slot availability, subscription status. **Two controlled exceptions**, both
written only by the posting transaction and reconciled nightly: `stock_balances` (a cache of
the movement ledger that gives the DB a row to lock and a `CHECK ≥ 0`, D-38) and
`ledger_entries` (the double-entry journal, D-43). What is stored because it must not move
after the fact: document numbers, finalized records, prices and costs snapshotted on lines,
and lot cost and MRP.

## 5. Multi-tenant architecture
- **Shared DB, shared schema, `tenant_id` on every tenant-owned row**, with **composite FKs**
  `(tenant_id, x_id) → x(tenant_id, id)` so cross-tenant references are constraint errors
  (D-03, D-26).
- **Business type gating:** `tenants.business_type` (`clinic` | `clinic_pharmacy` |
  `pharmacy`; `clinic_pharmacy` at launch, D-58) decides which modules exist: navigable, grantable and postable. This is
  HRestroSewa's `hasRooms` pattern. **Plan entitlements** (`plans.features`) gate optional
  modules (lab, SMS, multi-store) on top of that.
- **Identity vs membership:** one Auth user → `tenant_members` (one row per tenant).
  The MVP UI is one tenant per login, but the model supports more later (D-24, P-16).
- **Tenant lifecycle:** `pending` (application approved, setup not complete) → `active` →
  `suspended` (unpaid/abuse: dashboard read-only or blocked, public booking off) → `closed`.
  The guard checks this live on every request.
- **Tenant resolution:** internal surfaces read the tenant from the membership, never from
  the URL. The slug in `/login/[slug]` only chooses which sign-in screen to show, as in
  HRestroSewa. Public surfaces resolve the tenant from `[slug]` (or the host in P2), and
  every public action re-checks that the tenant is active and its website published.
- **Caching:** HRestroSewa's `tenantCache` (tenant id in key and tag) holds non-PHI config
  only: tenant profile, website content, departments, services, doctor public profiles,
  schedules. **Patient, stock and money data are never cached across requests.**

## 6. Authentication & sessions (dual model, D-27)
All internal accounts (Super Admin, Admin, Employee) have a **conventional identity: email +
password** in Supabase Auth. The HRestroSewa-style **tenant link + PIN** is kept as a
**quick-access layer on top of that identity**, never as a separate account.

| Entry | URL | Who | Result |
|---|---|---|---|
| Generic sign-in | `<domain>/login` | Admin, Employee | email + password (+ MFA if enrolled/required) → **A2/A3** |
| Tenant sign-in link | `<domain>/login/[slug]` | Admin, Employee | tenant-branded. **Untrusted device:** email+password only, and no staff list is shown. **Trusted device:** staff picker + PIN pad, *and* a "Use password" option |
| PIN quick access | (on the tenant link, trusted device only) | employees, and admins *for employee-level work* | PIN verified by `verify_pin` RPC → server mints a session for that user → **A1** |
| PIN unlock | idle lock screen | the signed-in user | unlocks the **same** session and keeps its level only if a password sign-in happened on this device within the shift window (default 12h); otherwise it drops to A1 |
| Super Admin | `<domain>/superadmin/login` | platform | email + password + **mandatory TOTP** → A3. No PIN, no tenant link |

How it fits together without conflicting sessions:
- **One identity per person.** HRestroSewa stores the PIN as the Supabase password of a
  synthetic account. CMediSewa stores the PIN as an **argon2id/bcrypt hash in
  `member_pins`**, separate from the Auth password, so the person keeps one `auth.users` row.
- **Session minting after a PIN:** the server verifies the PIN in SQL (with lockout), then
  creates a normal Supabase session for that user server-side. The candidate mechanism is
  `auth.admin.generateLink` + `verifyOtp(token_hash)` in the SSR client, to be proven in the
  B1 spike (P-23).
- **Assurance is recorded per session:** `session_assurance(session_id, level, method,
  device_id, password_auth_at, …)` keyed by the JWT's `session_id` claim. MFA (`aal2` claim)
  raises a session to A3. Guards read assurance in the same context RPC.
- **One active user per device:** switching user from the staff picker first signs out the
  current *local* session (HRestroSewa's local-scope logout), then signs in the next person.
  Each device holds one session at a time, and the same person on two devices has two
  independent sessions.
- **Step-up:** an operation needing a higher level shows a re-auth dialog (password, then
  TOTP if required), which upgrades the **current** session's assurance in place. The user
  doesn't sign in a second time.
- **Trusted devices:** an admin enrols a device for one tenant (`trusted_devices`, hashed
  token in an httpOnly cookie that lasts up to 400 days). It can be revoked at any time.
  Only trusted devices show the staff picker, which closes HRestroSewa's unauthenticated
  staff list.
- Remembering the tenant on the device: an httpOnly `cm_last_tenant` cookie set when
  the link is opened, like HRestroSewa's `rs_last_slug`. A PWA installed from the tenant
  link opens on that tenant's sign-in.
- Local JWT verification via `getClaims()` falls back to the network on error and never
  returns "signed out" on a verify failure. Deactivation is immediate (live membership read).
The full operation-by-level matrix is in `permissions.md` §3. Recovery flows are in
`workflows.md` W-20.

## 6a. Final login flows (Revision 4)
| # | Flow | Entry | Credential | Result | Restrictions |
|---|---|---|---|---|---|
| L1 | Super Admin sign-in | `<domain>/superadmin/login` | email + password + **TOTP (mandatory)** | A3 session, `platform_admins` checked live | no PIN, no tenant link, no trusted-device shortcut; optional IP allow-list (P-32) |
| L2 | Admin/Employee sign-in | `<domain>/login` | email (or username, P-18) + password (+ TOTP if enrolled/required, P-11) | A2/A3; membership + tenant status checked live; lands on admin dashboard or role home | lockout on failures; no account enumeration |
| L3 | Tenant link, untrusted device | `<domain>/login/<slug>` | same as L2 (tenant-branded) | as L2 | **no staff list shown**; slug only selects branding; the membership must belong to that tenant, otherwise "no access to this clinic" |
| L4 | Tenant link, trusted device, PIN | same, on an enrolled device | pick name + **6-digit PIN** | A1 session for that person, `device_id` recorded | only members allowed on that device with a PIN set; per-member lockout 5 → 15 min; per-device 20/h → password required; one active user per device |
| L5 | Idle lock & unlock | any session | PIN or password | same session; level kept only within the shift window after a password sign-in on that device | the screen is hidden while locked |
| L6 | Step-up | an operation needing A2/A3 or re-auth | password (+ TOTP) | the current session's level is raised, `reauth_at` stamped | no second session; the reason is shown |
| L7 | Switch user | lock screen / menu on a trusted device | → L4 | the previous local session is signed out first | never two people in one session |
| L8 | Logout | menu | — | local scope (this device) | "sign out everywhere" is a separate, deliberate action |
| L9 | Recovery | "Forgot password" / admin | email link, or admin one-time code (username accounts) | new password; all sessions revoked; PIN must be re-set | admins can't see or set anyone's PIN or password |
| P1 | Patient guest booking | `<domain>/c/<slug>` | none (CAPTCHA, rate limits, optional OTP P-04) | appointment + manage link (hashed 128-bit token) | the manage link shows only that appointment |
| P2 | Patient account | `<domain>/c/<slug>` → Sign in | email OTP (SMS later, P-20) | `cm_patient` session scoped to that tenant's path | sees own bookings; clinical documents only via a **reception-verified** link (P2) |
**Tenant awareness:** internal sessions are tenant-bound through the membership resolved on
every request. A person with memberships in two tenants (P-16) picks one at sign-in, and the
context carries that `tenant_id`. Patient sessions are tenant-bound by construction (the
account row belongs to one tenant). No URL or form value can change the tenant of a request.

## 7. Client / Patient website
- **Tenant-specific, admin-managed (D-34).** The Admin's **Website** module edits
  `site_settings` (published flag, theme colour, hero, about, contact, hours, social links,
  SEO, what to show), `site_announcements`, `site_media` (gallery) and `site_faqs`. It also
  chooses which departments, services and doctors are public (their `is_public` flags).
  This mirrors how HRestroSewa's admin-managed menu feeds `/c/[slug]`.
- **Data contract:** `app/actions/public/*` only, returning allow-listed types
  (`PublicTenant`, `PublicDoctor`, `PublicService`, `PublicSlot`). It never returns MRNs,
  internal ids of other patients, or clinical data. Markdown content is sanitised, and no
  raw HTML is allowed.
- **Caching:** content pages use ISR / `revalidateTag(tenant)` when the admin publishes.
  Slots and booking are always fresh.
- **Booking without an account (guest):** name, phone, age/DOB, sex, optional email and
  reason, consent, CAPTCHA. The patient receives a reference number and a **manage link**
  with a hashed 128-bit token.
- **Optional patient account (D-31):** register or sign in with an **OTP** (email in the MVP,
  SMS once P-05 is decided, P-20). It is scoped to **that tenant** (`patient_accounts`) and
  uses an app-managed session (`patient_sessions`, httpOnly `cm_patient` cookie scoped to
  `/c/[slug]`). It never touches Supabase Auth, so patient sessions can't collide with staff
  sessions and patients never exist in `auth.users`.
  - An account adds: saved details, a family-member list, "my appointments", booking status
    and history.
  - **Required only for** viewing clinical documents online (prescriptions; lab reports in
    P2), and only after reception has **verified the link** between the account and the
    patient record in person (`patient_account_links.verified_at`). A matching phone number
    alone never reveals records.
- Abuse controls: rate limits per IP/phone/account, CAPTCHA, a cap on active future bookings
  per phone, optional OTP verification for guest bookings (P-04).
- URLs: `<domain>/c/<slug>` in the MVP. `<slug>.<domain>` in P2 via a `proxy.ts` host
  rewrite, and custom domains later (D-13). Everything else (marketing, sign-in, Admin,
  Employee, Super Admin) shares the **same host** (D-59, HRestroSewa model). The safeguards
  that replace host separation are listed in `security.md` §2 and §8.

## 8. Settings architecture
HRestroSewa keeps settings owner-only, one card and one Server Action per setting, cached and
revalidated on every write. CMediSewa does the same, but uses **typed tables** instead of a
`settings jsonb`, because booking, invoicing and stock rules are read by SQL in RPCs:
`tenant_settings` (booking rules, invoice format, day-closing hour, push privacy, PIN policy,
low-stock defaults, credit policy) and `site_settings` (public website). Sensitive settings
need A2 plus re-auth (`permissions.md` §3).

## 9. Inventory, pharmacy, purchasing, sales & finance (Revision 3)
Tables are in `database.md` §8–§12 and the flows in `workflows.md` W-13–W-17 and
W-21–W-30. Decisions: D-38 to D-46.

### 9.1 What changed from HRestroSewa, and why
| Concern | HRestroSewa (verified in code) | CMediSewa |
|---|---|---|
| Item | `products`: one free-text unit ("buy in the unit you sell in"), `last_unit_cost`, `opening_stock` column, `low_stock_threshold` | item master + medicine details, **units with conversion factors**, barcodes per unit, min/reorder/max per store |
| Lots | none | `item_batches`: **one row per received lot** (batch no., mfg, expiry, cost, MRP, sale price, block status); never overwritten |
| Locations | none (workstations are only labels) | **stores** with member assignment; quarantine store |
| Stock | derived from opening + purchases − recipe usage ± signed adjustments | append-only **movement ledger** per store × lot (source of truth) + a trigger-maintained **balance cache with `CHECK ≥ 0`** (D-38) |
| Purchase | `record_purchase`: server-computed total, vendor row lock, advisory lock + `max()+1` numbering, CHECK cash + online + credit = total, stored `vendors.credit_balance` | the same server-side discipline, **plus** batch/expiry/MRP per line, free qty, discounts, tax, PO link, duplicate-bill guard, gapless counters, **derived payable** with payment allocations |
| Sale | `payments` per bill, cash/online/card + mixed in lockstep, discounts PIN-gated, net = sale | one **invoice** for services and items; **per-lot allocations**; same split and sign rules; payment allocations for dues |
| Finance | `finance_report`/`finance_transactions`: a union of source tables with four balance deltas; profit "estimated" because cost is approximate | a **double-entry journal** written by the same posting transaction (D-43) with the four HRestroSewa balances as account sums; **exact COGS** from lot cost; HRestroSewa-style derivation kept as the nightly reconciliation |
| Corrections | edit in place + Security PIN + audit (`edit_purchase`, `edit_payment_tender`) | **never edit posted documents**: void (narrow window) or a return/reversal posting, with re-auth + audit (D-45) |

### 9.2 Module dependencies (R2)
```
M-20 Item master & units ─► M-21 Stores, lots & stock ledger ─┬─► M-22 Vendors & purchasing (PO, invoices, returns, payments)
                                                              ├─► M-23 Pharmacy counter & dispensing ─► needs M-19 Rx, M-24
                                                              └─► M-24 Sales & billing (item lines, allocations, returns)
M-24 + M-22 + M-25 Expenses ─► M-26 Finance journal & balances ─► M-27 Reports (stock, expiry, purchases, vendor ledger,
                                                                                 sales, item margin, P&L, cash book)
P2: M-45 Reservations · M-46 Purchase suggestions & supplier performance · M-47 Cashier shifts · M-48 Controlled-drug register
    · M-49 Advanced barcode (GS1, camera, labels)          F: M-50 Accounting export / e-billing integration
```

### 9.3 The posting pipeline (one shape for every stock or money change)
```
Server Action (validates input, checks permission + store assignment + assurance level)
  └─► RPC post_<document>(p_tenant, p_actor, p_idempotency_key, payload)
        1. insert postings(idempotency_key)    → duplicate key: return the original result
        2. lock: document row, affected stock_balances rows (ordered by store_id, batch_id),
                 vendor/patient row when a balance check is needed, document_sequences row
        3. validate: tenant ownership of every id (composite FKs as backstop), sellability,
                 quantities, return limits, credit limit, prescription requirement
        4. compute all totals in SQL (client totals ignored)
        5. write the document (+ number), stock_movements (trigger updates balances, CHECK ≥ 0),
                 ledger_entries (deferred check: balanced)
        6. audit_log for sensitive kinds; NOTIFY cm_events {stock|billing|purchases|finance}
  ◄── returns the document id + number, or a bare error code
```
Nothing outside this pipeline writes stock or money. `INSERT` on `stock_movements` and
`ledger_entries` is revoked from every login role (D-39).

### 9.4 Batch allocation (FEFO by default, D-40)
`allocate(store, item, base_qty, policy, chosen_batch?)` runs inside the posting
transaction and returns a list of (lot, qty):
1. Candidate lots in that store: `status = active`, `expiry_date > today +
   min_sale_shelf_days`, `on_hand − reserved > 0`.
2. Order by **expiry ascending (FEFO)**, then by received date (FIFO as the tie-break), then
   by id.
3. Take quantities until the request is filled. If it can't be filled, raise
   `INSUFFICIENT_STOCK` with the available quantity.
4. **Manual override:** the user may pick a specific lot (e.g. the patient wants the one
   with the longer expiry, or the pharmacist matches the physical box in hand). This needs
   `override_batch`, and the override is recorded on the allocation. An expired or blocked
   lot can **never** be picked.
- **Why FEFO, not FIFO:** medicines lose value by expiry date, not by arrival order. A later
  delivery can expire sooner. FEFO minimises expiry write-offs, and it matches common
  pharmacy practice (**Recommendation**; FIFO is available as a tenant setting for
  non-medicine stores).

### 9.5 Units at the counter
Scanning a barcode resolves the item **and** the unit (a box barcode gives a box). The
cashier can switch units, and the quantity is converted to base units for allocation.
Prices display per chosen unit (`sale_price_base × factor`). Loose sale below a pack needs
`allow_loose_sale` on the item.

### 9.6 Financial definitions (what each number means)
| Term | Definition | Source |
|---|---|---|
| **Sales revenue** | value of goods and services **invoiced** in the period, net of discount, excluding tax, minus sales returns | REV_* accounts |
| **Cash received** | money actually collected in the period (cash + online legs), **including** collections of older dues and **excluding** unpaid amounts. Refunds reduce it | CASH/BANK debits from receipts |
| **Outstanding credit (receivables)** | invoiced but not yet paid, at a point in time | AR_PATIENTS balance |
| **Vendor payables** | purchased on credit and not yet paid, at a point in time | AP_VENDORS balance |
| **Purchases** | inventory **bought** in the period, at cost. **Not an expense**: it becomes inventory | INVENTORY debits from purchase invoices |
| **Purchase payments** | money paid to vendors in the period (at purchase time + later payments) | CASH/BANK credits to vendors |
| **COGS** | the cost of exactly the lots that were sold (Σ allocation qty × lot cost) | COGS account |
| **Gross profit** | sales revenue − COGS | derived |
| **Inventory losses** | expiry, damage, loss, theft, count shortage, transit loss, disposal (at cost), net of gains | INV_LOSS − INV_GAIN |
| **Operating expenses** | rent, salaries, utilities… | EXP_* |
| **Net profit (actual)** | gross profit − inventory losses − operating expenses + other income | derived |
| **Cash balance / online balance** | HRestroSewa's two money balances, now account sums. Card counts as bank | CASH, BANK |
**Mixed payments** post two debits (CASH and BANK) in one posting, so "cash in hand" can
never drift from what the receipt says (HRestroSewa's lockstep rule, enforced by the journal
and the CHECK). Revenue is recognised at **issue** (accrual, HRestroSewa's credit model).
Profit is **actual, not estimated**: every sold unit carries its lot cost.

### 9.7 Store-wise vs tenant-wide
Every stock movement and every revenue, COGS, inventory and loss entry carries `store_id`.
So per store you get: on-hand and value, sales, gross margin, losses and transfers in/out.
Tenant-wide figures are the sum across stores. Cash and bank are **tenant-wide** (one till
per tenant in the MVP; cashier shifts per counter are M-47, P2). Expenses are tenant-wide
with an optional store tag.

### 9.8 Alerts & background jobs (pg_cron → secret-gated routes)
- **Low stock:** after any posting that removes stock, plus daily. Per store against the
  store-level or item-level reorder and min levels. Goes in-app to the store's inventory
  members and appears on the dashboard. Push only for "critical" (below min).
- **Near expiry:** daily, flags lots within `near_expiry_days` (amber) and
  `critical_expiry_days` (red). A digest goes to inventory roles.
- **Expired:** at the tenant day boundary, lots past expiry become unsellable automatically
  (the check is date-based, so no job is needed to block them). The job only produces the
  "move to quarantine" task list.
- **Reconciliation:** nightly `reconcile_stock_balances` + `verify_finance_integrity`. A
  mismatch alerts the Super Admin ops channel (counts only, no tenant data) and the tenant
  admin.
- **Purchase suggestions (MVP-lite):** items at or below the reorder level → suggested qty =
  `reorder_qty` (or max − available − on order). P2 uses sales velocity × lead time (M-46).

## 10. Realtime, notifications, email, PWA
- **Realtime:** DB triggers `NOTIFY cm_events {tenant_id, topic}`, with one `LISTEN` session
  connection per process and SSE to that tenant's members. **Topic names only** (D-09).
  Topics: `appointments`, `queue`, `encounters`, `billing`, `stock`, `purchases`, `finance`,
  `website`, `settings`, `staff`, `notifications`. The public site uses short polling for
  booking status.
- **Notifications:** an in-app panel (the record), web push (the signal) and patient
  email/SMS through a `notification_outbox` that cron dispatches with exactly-once delivery.
  **PHI-minimal content** on every external channel (D-10). Push recipients are resolved
  through the same visibility predicate as the panel. Low-stock and near-expiry alerts go to
  inventory roles.
- **Email:** one platform sender via Resend over HTTPS (D-17). It never throws and retries.
- **PWA:** the employee and admin areas are installable. The HRestroSewa service-worker
  posture applies: cache nothing dynamic, never intercept authenticated responses, serve
  `sw.js` with `no-store`, and `OfflineGate` refuses writes while offline. No PHI at rest on
  the device (D-21). The manifest `start_url` points at the remembered tenant link.

## 11. Deployment architecture
App container + its **own** self-hosted Supabase stack under Coolify, separate from
HRestroSewa. Postgres has no public port and Kong `/pg` is blocked (D-15). Environments are
dev, staging and prod. **One host** `<domain>` serves every area (D-59). See `deployment.md`.

## 12. Folder structure (planned; created in B0)
```
app/
  (marketing)/  (public)/c/[slug]/  (auth)/login/[slug]?/
  (admin)/admin/*   (employee)/employee/*   (superadmin)/superadmin/*
  actions/            tenant actions, one module per domain (shared by admin + employee)
  actions/public/     the ONLY actions the patient site may call
  actions/platform/   super admin + marketing registration
  api/realtime  api/cron/*  api/push/action  api/files/[id]  api/health
lib/
  auth/ (context, guards, assurance, trusted-devices, pin)  permissions.ts  care-access.ts
  audit.ts  clinic-time.ts  scheduling/  inventory/  billing/  finance/  notify/  realtime/
  supabase/  cache/  email/  pdf/
components/ui/  components/pwa/  components/branding/  components/site/ (public theme)
supabase/migrations/  supabase/cron/
scripts/migrate.mjs  scripts/lib/
```

## 13. Patterns reused from HRestroSewa (summary)
Route-group separation of the five areas · admin layout admits any active member, and pages
guard themselves · shared client components across admin and employee · server-only data
access with an RLS deny-all backstop · middleware that only redirects · live membership
check · tenant link + remembered tenant cookie + PIN pad (hardened) · DB-clock PIN lockout ·
permission sections, levels and presets with navigation derived from them · business-type
module gating · record-level visibility predicate · topic-only SSE · push resolved through
the same predicate · Resend mailer · pg_cron → secret routes · exactly-once delivery ·
server-computed totals, row locks and CHECK-balanced splits from `record_purchase` ·
purchase as single source of stock-in/payable · FIFO settlement of dues and payables ·
same-sign split check · net-is-the-sale · expenses/other-income shapes · four money balances
(now journal accounts) ·
expenses shape · one time module · migrations that own grants · guarded migration runner.
