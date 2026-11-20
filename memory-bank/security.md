# Security & Privacy

Status: **Recommendation.** CMediSewa makes **no compliance claim** of any kind. §10 lists
legal areas that need verification by qualified Nepali counsel before launch.

## 1. Threat model (what we defend against)
| Threat | Example | Primary controls |
|---|---|---|
| Cross-tenant leak | bug returns clinic B's patients to clinic A | `tenant_id` from live membership, composite FKs, scoped data helper, tests (§4) |
| Curious insider | receptionist reads a neighbour's diagnosis | capability + care relationship, read audit, admin review (§5, §6) |
| Compromised staff account | phished password | MFA, lockout, idle timeout, session revocation, anomaly alerts (§2) |
| PIN guessing / staff enumeration | someone with the tenant link tries PINs; lists staff names | PIN only on admin-enrolled trusted devices, no staff list elsewhere, 6 digits, per-member and per-device lockout, A1 ceiling (§2) |
| Patient account takeover | someone with the same phone or email claims another's records | OTP sign-in, rate limits, clinical documents only through reception-verified links (§8) |
| Public-booking abuse | slot squatting, spam, enumeration | CAPTCHA, rate limits, per-phone caps, hashed manage tokens, no enumeration (§8) |
| Leaked anon key | the key is public by design | zero grants to `anon`/`authenticated` (§4) |
| Server compromise / DB exposure | exposed Postgres or `/pg` route | no public DB port, `/pg` blocked, SSH key-only, patching (§7) |
| Data loss | disk failure, bad migration, ransomware | off-site encrypted backups, PITR, restore drills (§9) |
| Leak through side channels | PHI in push, SMS, logs or error reports | content rules + redaction (§7) |

## 2. Authentication (dual model, D-27)
- **Primary identity for every internal user** (Super Admin, Admin, Employee): Supabase Auth,
  **invite-only** (public signup disabled), email (or a tenant-scoped username, P-18) plus a
  password of 10 characters or more, checked against a common-password list. This gives
  **A2**.
- **MFA (TOTP)** gives **A3**. It is mandatory for Super Admins. For tenant admins and
  doctors it is mandatory or recommended per P-11. Recent re-auth (5 min) is required for
  break-glass, permission changes, voids/refunds, settings, publishing and exports
  (`permissions.md` §3).
- **Quick access (A1):** the tenant link `/login/[slug]` + a **6-digit PIN** (P-19), **only on
  admin-enrolled trusted devices.** The PIN is an argon2id/bcrypt hash in `member_pins`,
  never the Auth password, so each person has one identity. `verify_pin` enforces a
  per-member lockout (5 → 15 min) and a per-device throttle (20 failures/hour → the device
  needs a password), using the DB clock. Untrusted devices see no staff list (this fixes the
  HRestroSewa enumeration path). A1 can never reach clinical records, the Admin area or
  sensitive operations.
- **Lockout** for passwords and MFA codes too. An admin unlock is audited.
- **Sessions:** HttpOnly, Secure, SameSite=Lax cookies (via `@supabase/ssr`), on the single
  host (D-59), with Supabase cookie names distinct from the patient cookie `cm_patient`. Access-token TTL about 1h with refresh rotation. Each session's
  assurance is in `session_assurance` (keyed by the JWT `session_id`). One user per device:
  switching user signs out locally first. An **idle lock** (default 10 min on trusted
  devices, 15 on others) blurs the screen. A PIN unlock keeps A2 only within the shift
  window of a password sign-in on that device. Logout is local scope. "Sign out everywhere"
  is deliberate (user or admin). A password reset revokes all sessions and forces a PIN
  change.
- **Device trust** is revocable at any time. Revoking it kills the PIN sessions minted on
  that device. Device enrolment and revocation are audited.
- **Patient sessions are entirely separate** (D-31): OTP sign-in, `patient_sessions`
  cookie scoped to `/c/[slug]`, never Supabase Auth.
- **Deactivation is immediate:** the membership row is read live on every request (an
  HRestroSewa pattern).
- Local JWT verification via `getClaims()` uses asymmetric signing keys and falls back
  to the network on error. It never treats an error as "signed out".

## 3. Authorization
Three independent checks: tenant, capability, record (`permissions.md` §1). They are
enforced **server-side in every page and action**. Clinical data is reachable only through
RPCs that check the care relationship in SQL, so one forgotten check in TypeScript cannot
expose a chart. The tenant Admin doesn't bypass clinical rules and the Super Admin has no
clinical access (D-06, D-08).

## 4. Tenant isolation
1. `tenant_id` comes **only** from the server-resolved membership, never from a form field,
   URL or cookie. Actions that receive an id (patient, appointment) verify that it belongs
   to `ctx.tenant_id` by querying with both.
2. **Composite foreign keys** make cross-tenant references impossible in the DB.
3. The `db(ctx)` helper injects `tenant_id` into tenant-scoped queries.
4. Tenant-scoped caches include `tenant_id` in both the key and the tag (`tenantCache`).
   **PHI is never cached.**
5. **The browser never queries the DB.** `anon`/`authenticated` hold no grants. RLS is on
   for every table as a deny-all backstop. CI fails on any table with RLS off or any grant
   to those roles.
6. **Automated isolation tests:** for every action and RPC, a test seeds two clinics and
   asserts that clinic A's member can't read, write or reference clinic B's rows. This is a
   gate in the MVP's definition of done.

## 5. Patient data protection
- **Minimise:** collect only what the workflow needs. National ID is not collected by default
  (**[OPEN]**). Reason-for-visit is optional.
- **Classify:** *clinical* (encounters, notes, diagnoses, Rx, allergies, conditions, lab,
  files), *personal* (demographics, contact) and *operational* (appointments, tokens,
  invoices). Each class has its own access rules (`permissions.md` §5).
- **Immutability:** finalized encounters, issued prescriptions and issued invoices are
  frozen by triggers. Corrections are addenda, cancellations or voids, each with an actor and
  a reason.
- **No PHI on devices:** the service worker caches nothing dynamic. Logout clears caches. No
  localStorage or IndexedDB for patient data. Print views are rendered on demand.
- **Encryption:** TLS everywhere. Disk/volume encryption on the VPS where the provider
  supports it. Backups are encrypted before leaving the host. Column-level encryption of
  clinical text is **not** proposed for the MVP: the DB is server-only, and it would break
  search. Revisit if counsel or a risk review asks for it.
- **Exports:** admin-only for clinical content, audited, and watermarked with the
  exporter's name and time.

## 6. Supabase RLS strategy
**Recommended (D-04): server-only access + deny-all RLS + clinical RPCs.**
- Every table has RLS enabled and no policies for `anon`/`authenticated` (they also hold no
  grants). All access goes through `service_role` on the server.
- Clinical reads and writes go through `SECURITY INVOKER` RPCs executed by `service_role`
  that receive `p_actor_member_id` and `p_tenant_id` (taken from the verified server
  context), evaluate the **care predicate** in SQL and insert the `audit_log` row in the
  same transaction. A denied read is also audited (`outcome = denied`).
- **Why not per-user RLS (JWT claims + policies) as the main layer?** It would require
  exposing tables to the `authenticated` role (so any XSS or token theft becomes direct
  table access), custom access-token hooks for `tenant_id`/permissions, and policies
  complex enough to encode the care rules, which are hard to test and slow. HRestroSewa
  rejected browser-side access for the same reason. **Alternative kept open:** if a future
  feature needs direct client queries (e.g. a native app), introduce per-user RLS for that
  table set only, with policies mirroring the care predicate.
- **What gets audited as a read:** opening a chart, viewing an encounter, viewing or printing
  an Rx, viewing lab results, downloading a clinical file, break-glass and exports.
  Lists and searches that show demographics and appointment times only are not logged per
  row. Opening a patient's profile page is logged as `patient.profile_read`.

## 7. API security
- **Server Actions** are the API. Each re-validates input with schema validation (zod or
  valibot) and checks auth and permissions. Pure helpers are never exported from
  `"use server"` files. Next's built-in Server Action origin check stays on, with
  `allowedOrigins` limited to the app origin.
- **Cron routes:** `x-cron-secret` compared in constant time, 404 on failure, POST only.
  Secrets come from Vault for pg_cron.
- **Rate limiting:** per IP and per identity on login, booking, manage-link actions and OTP
  (P-04). Stored in Postgres (simple counter table) or in memory for one instance (one
  container in the MVP). Multi-instance later needs Redis or Postgres.
- **Headers:** CSP (no inline scripts except Next nonces; `frame-ancestors 'none'` for the
  dashboard), HSTS, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`
  (so manage-token URLs don't leak), and `Permissions-Policy`.
- **Uploads:** MIME sniffing plus an allow-list, a size cap, uuid names, private bucket for
  clinical files and image re-encoding for public photos.
- **Secrets:** server-only modules (`server-only` import). The service key is never in client
  bundles. CI scans the bundle for it.
- **PHI-free side channels:** push payloads, SMS, email, logs, error reports, analytics and
  URLs (no names or phones in query strings) all exclude clinical content. There is no
  third-party analytics on dashboard pages. The public site may use privacy-friendly
  analytics without cookies.
- **Infrastructure:** no public Postgres port, Kong `/pg` and Studio blocked publicly, SSH
  key-only, automatic patching, Docker images updated monthly.

## 8. Secure appointment booking
- **Inputs:** validated server-side (phone `+977` format, name length, date windows).
- **Bots and spam:** CAPTCHA on submit, per-IP and per-phone rate limits, and at most N
  active future online bookings per phone per clinic (default 2). Repeated no-shows lower
  that limit (W-18).
- **Optional OTP** (P-04): SMS OTP to confirm phone ownership before the booking is
  confirmed. Until it exists, online bookings may be configured as `requested` (manual
  confirmation) for clinics that want it.
- **No enumeration:** public endpoints never reveal whether a phone or patient already
  exists. Matching happens server-side and the response is identical either way.
- **Manage tokens:** 128-bit random, stored as an HMAC-SHA256 hash with a pepper, scoped to
  one appointment, expiring after the appointment date plus N days, and rotated on reschedule.
  The page shows only that appointment's logistics.
- **Conflicts:** GiST exclusion constraints make double booking impossible under concurrency.
  The RPC returns `SLOT_TAKEN` and the UI offers the nearest alternatives.
- **Public data contract:** `app/actions/public/*` returns explicit allow-listed types. A
  test asserts that no public response contains an MRN, a patient id other than the
  caller's own booking, or any clinical field.
- **Patient accounts (optional, D-31):** OTP codes are 6 digits, hashed, expire within 10
  min, allow at most 5 attempts, and are resend-throttled per destination and IP. Responses
  are identical whether an account exists or not. The session cookie is hashed server-side,
  scoped to the tenant path, and revocable. An account sees only appointments it booked
  until reception **verifies** the account↔patient link in person. Only verified links will
  unlock clinical documents online (P2).
- **Tenant website content** is authored by tenant admins and rendered as sanitised
  Markdown (no raw HTML or scripts). Media uploads are re-encoded. It is served on the
  same host as the dashboards (D-59), so the public pages get the same strict CSP (nonces, no
  inline scripts, no third-party scripts except an allow-listed map/CAPTCHA), and **staff
  are directed to book from the Registrar dashboard, not the public site**, so a staff
  session is rarely open on public pages. Server Actions keep Next's origin check.
- **Marketing registration:** CAPTCHA, email verification, per-IP limits, manual approval
  (D-29).

## 9. Backup & recovery
See `deployment.md` §9: nightly verified dumps, encrypted off-site copies, WAL-based PITR
(RPO ≤ 15 min, RTO ≤ 4 h targets) and monthly restore drills with parity checks.
Disaster runbook: restore order (DB → storage → app), DNS cutover, key rotation if a
compromise is suspected, and clinic communication.

## 10. Privacy & compliance, to verify (not claimed)
These Nepal-specific areas were identified as relevant. **None has been verified for
CMediSewa.** Each needs confirmation from current official texts and/or qualified Nepali
legal counsel before production launch (tracked as P-08, P-09, P-10):

| Area | Instrument (to verify current text) | Questions for counsel |
|---|---|---|
| Constitutional privacy | Constitution of Nepal 2072 (2015), Art. 28 | baseline right that the other laws implement |
| Personal data & health privacy | **Individual Privacy Act 2075 (2018)** and **Privacy Regulation 2077 (2020)** | consent requirements for health data; purpose limitation; disclosure rules; data-subject access/correction; obligations of a data processor (CMediSewa) vs controller (clinic); penalties |
| Health institutions | **Public Health Service Act 2075 (2018)** and Regulation 2077 | patient confidentiality and record duties; **medical-record retention periods**; health-facility reporting (e.g. HMIS/DHIS2) obligations that clinics may expect the system to support |
| Professional conduct | **Nepal Medical Council** Act and Code of Ethics | confidentiality; prescription content (registration no., signature); validity of electronic prescriptions/signatures |
| Electronic records & signatures | **Electronic Transactions Act 2063 (2008)** | legal standing of electronic medical records and digital signatures; unauthorised-access offences |
| Medicines | **Drugs Act 2035 (1978)**, Department of Drug Administration rules | Rx format; controlled-drug prescriptions; pharmacy module requirements (Future) |
| Tax & billing | **VAT Act 2052 (1996)** and Rules, Inland Revenue Department billing-software rules | whether health services are VAT-exempt; mandatory invoice fields; whether billing software must be IRD-registered/certified; fiscal-year numbering; real-time reporting (CBMS) applicability |
| Data residency & security | **National Cyber Security Policy 2080 (2023)** and any directives | whether health data must be hosted in Nepal (drives P-09); incident reporting duties |
| Consumer protection | Consumer Protection Act 2075 (2018) | booking/cancellation terms and fee disclosures on the public site |
| Clinic licensing | Ministry of Health and Population health-institution standards | any software or record-keeping requirements in licensing standards |

**Product guardrails until verified:** collect explicit consent at registration and booking
(text drafted with counsel); provide data-subject request handling (export/correct) as an
admin workflow; define **clinic = controller, CMediSewa = processor** in a Data Processing
Agreement; publish a privacy notice on each clinic site; **never hard-delete clinical
records** until retention rules are known (soft delete + restricted access); keep audit logs
at least as long as records.

**Data retention & deletion policy (draft, pending P-10):**
- Clinical and financial records are retained for the legally required period (unknown;
  placeholder **10 years** from the last encounter). The tenant Admin cannot hard-delete them.
- Demographic "erasure" requests: restrict and anonymise contact fields where the law
  permits, and keep clinical content as required.
- A closed clinic's data is exported to the clinic (encrypted archive) and then retained or
  deleted according to the DPA and the law.
- Logs are kept 30–90 days. Backups follow the backup rotation, so deleted data ages out of
  backups by the end of the rotation.
- Retention jobs run by pg_cron are audited and dry-run first.

## 11. Inventory & financial integrity (Revision 3)
**Threats:** phantom stock (quantities changed without a document), double posting (double
taps, retries), back-dated or edited bills, discount and refund abuse, fake returns, count
manipulation, cost/margin leakage to counter staff, selling expired, recalled or
prescription-only medicines, cross-tenant references in stock documents, and drift between
stock, money and documents.

| Control | How |
|---|---|
| **No quantity without a movement** | `stock_movements` and `ledger_entries` accept inserts only from `SECURITY DEFINER` posting functions owned by a non-login `ledger_writer` role. INSERT/UPDATE/DELETE are revoked from `service_role` and every login role. `stock_balances` is written only by the movement trigger (D-39) |
| **Non-negative stock** | `CHECK (qty_on_hand >= 0)` + row locks in a deterministic order inside postings (D-38) |
| **Atomicity** | each document posts its rows, movements and journal in one transaction. The journal's balance (Σ debit = Σ credit) and allocation completeness are deferred constraint triggers |
| **Duplicate prevention** | `postings(idempotency_key)` unique per tenant (D-44); duplicate vendor bill guard; gapless `document_sequences` under row lock |
| **Immutability** | posted documents, movements, journal entries and postings can't be updated or deleted (triggers). Corrections are reversal postings (D-45). Voids are limited to the same business day (sales) or untouched lots (purchases) |
| **No back-dating** | the posting time is `now()` (DB clock). Vendor bill dates are informational. Expenses land today (HRestroSewa rule) |
| **Sellability in SQL** | `allocate()` refuses expired, blocked and recalled lots and non-sellable stores. `issue_invoice` refuses Rx-required items without an Rx link and controlled items until M-48. The UI is never the last line |
| **Price integrity** | the sale price comes from the lot. An override needs a reason and a permission. Price above MRP is refused (P-25). Price changes are logged in `batch_price_history` |
| **Discount / refund abuse** | role discount limits; above them needs A2 + re-auth; returns only against the original invoice and lot, ≤ sold − returned; refunds A2 + re-auth; daily summary lists voids, returns, discounts and overrides per cashier |
| **Count manipulation** | blind counts option; point-in-time system qty; posting by a different member (setting); every variance audited with a reason |
| **Cost confidentiality** | cost, margin and finance need `view_cost_prices`/`view_finance` (A2). Counter screens and exports hide cost otherwise |
| **Tenant isolation** | composite FKs on every inventory, purchasing, sales and finance table, including `(tenant_id, batch_id, item_id)` on movements and `(tenant_id, store_id)` on allocations. The two-tenant isolation suite covers every posting RPC |
| **Store isolation** | store-scoped keys (`permissions.md` §5a) are checked in SQL inside postings, not only in actions |
| **Reconciliation** | nightly `reconcile_stock_balances` (balances = Σ ledger) and `verify_finance_integrity` (journal = documents, recomputed HRestroSewa-style). Mismatches alert and are audited |
| **Audit** | postings record actor, session level, device and idempotency key. Overrides, voids, returns, adjustments, price changes, blocks and opening balances also write `audit_log` |
| **Medicine safety** | allergy check at dispensing (C7). Substitutions need a reason. Near-expiry and critical alerts. A recall block applies in every store at once |
**Regulatory items to verify (adds to §10, P-22):** prescription-only and controlled-drug
categories and record-keeping (Drugs Act 2035 / DDA), pharmacist presence requirements
(Nepal Pharmacy Council), MRP display and pricing rules, VAT treatment of medicines vs
services, IRD rules on invoice cancellation and credit notes, and medicine-waste disposal
rules. **No compliance is claimed.**

## 12. Tenant isolation checklist (Revision 4 audit)
| Layer | Isolation rule | Status |
|---|---|---|
| Database | `tenant_id` on every tenant table; composite FKs `(tenant_id, x_id)`; `unique (tenant_id, …)` on every business key; no anon/authenticated grants | designed (`database.md` §1, §16) |
| Request context | `tenant_id` comes only from `resolve_request_context` (live membership); public actions resolve it from the slug and re-check active + published | designed (`architecture.md` §4–§7) |
| RPCs | every RPC takes `p_tenant_id` from the context and validates each referenced id with `tenant_id` (composite FKs as backstop). Posting RPCs also check store access | designed (§9.3) |
| Function classes | **clinical RPCs** run as `service_role` and enforce the care predicate + audit. **Posting RPCs** are `SECURITY DEFINER` owned by `ledger_writer` (the only writer of movements/journal, D-39). Both take the actor and tenant explicitly and trust no session variable | clarified |
| Caches | `tenantCache` key and tag both include `tenant_id`; no PHI, stock or money cached | designed |
| Realtime | the SSE bus fans out by `tenant_id` from the authenticated context; payload = topic only | designed (D-09) |
| Push / email / SMS | recipients resolved within the tenant through the visibility predicate; PHI-minimal | designed (D-10) |
| Storage | object paths `/<tenant_id>/…` in both buckets; private clinical files only via signed URLs issued after a tenant + care check | **added**: enforce the path prefix in the upload actions and test it |
| Cron jobs | iterate per tenant, with `tenant_id` passed into each RPC; no cross-tenant aggregate except the Super Admin's count-only metrics | designed |
| Reports & exports | every report function takes `p_tenant_id`; exports are watermarked and audited | designed |
| Patient sessions | the account row belongs to one tenant; the cookie path is scoped to `/c/<slug>`; the session lookup checks tenant = slug's tenant | designed (D-31) |
| Trusted devices / PIN | the device row belongs to one tenant; the PIN picker lists only that tenant's allowed members | designed (D-27) |
| Super Admin | no PHI, stock or finance detail; aggregate counts only | designed (D-08) |
| Backups | whole-DB backups contain every tenant, so access is limited to named operators; a per-tenant export exists for closure (W-33) | designed (`deployment.md` §9) |

## 13. Security risk register (open items)
| # | Risk | Severity | Mitigation / owner decision |
|---|---|---|---|
| R1 | PIN-to-session minting proves fragile or insecure | High | B1 spike P-23. Fallback: PIN-as-unlock only |
| R2 | Admin self-grants clinical access via a fake credential | High | D-52 (independent verification + notification); P-30 decides the verifier for single-admin tenants |
| R3 | Service-role key compromise = full bypass | High | server-only, rotation runbook, no laptop copies, Kong `/pg` blocked, bundle scan in CI |
| R4 | Shared reception devices left signed in | Medium | idle lock, A1 ceiling, device revocation, one user per device |
| R5 | OTP / booking abuse (SMS pumping when SMS arrives) | Medium | rate limits, CAPTCHA, per-destination caps, provider fraud controls (P-05) |
| R6 | XSS from tenant-authored website content | Medium | sanitised Markdown, no raw HTML, strict CSP with nonces on all pages, Server Action origin check, staff book via the Registrar dashboard (single host, D-59) |
| R7 | Stock or finance drift from a posting bug | Medium | ledger-only writes, CHECKs, deferred balance checks, nightly reconciliation, property tests |
| R8 | Controlled-drug misuse | High (legal) | blocked until M-48 + P-22 (D-47) |
| R9 | Data residency non-compliance | High (legal) | P-09 before go-live |
| R10 | Single VPS failure | Medium | off-site backups + PITR + restore drills; dedicated VPS (P-02) |
| R11 | Admin impersonation of username accounts (password reset) | Low–Medium | audited, employee notified; prefer email accounts (P-18) |
| R12 | Super Admin account compromise | High | mandatory TOTP, optional IP allow-list (P-32), platform audit, no tenant data reachable anyway |
