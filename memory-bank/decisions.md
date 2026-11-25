# Decisions

Append-only. Never delete an entry; add a follow-up that supersedes it. Every entry has a
status:
- **Proposed**: the recommendation from the 2026-11-20 architecture analysis, awaiting the
  owner's review.
- **Accepted**: confirmed by the owner.
- **Superseded**: replaced by a later entry.
`P-xx` entries are **pending decisions**, each with alternatives and a recommended default.

---

## Accepted / proposed decisions

**D-01 Technology stack. Proposed (2026-11-20).**
Next.js App Router + React + TypeScript (strict) + Tailwind v4 + radix-ui + lucide; Supabase
(Postgres, Auth, Storage) self-hosted; web-push; SSE; Resend; pdf-lib; `pg`.
*Reason:* HRestroSewa runs this exact stack in production for a similar Nepali SMB audience.
The team knows it, its traps are documented, and its components can be copied. Server
Actions as the API keep data access server-only, which the security model depends on.
*Alternatives:* a separate API (NestJS/Express) + SPA was rejected because it doubles the
surface area and auth plumbing for no MVP benefit. Laravel/Django were rejected because
they would lose all reuse from HRestroSewa. Firebase was rejected because its relational
integrity is weak and medical records need constraints.

**D-02 Copy reusable code; don't share a package. Proposed.**
*Reason:* the shared pieces are small (about 20 files). A monorepo or package would couple
CMediSewa's releases to a production POS. *Revisit* if a third product appears.

**D-03 Multi-tenancy: shared DB, shared schema, `clinic_id` + composite FKs. Proposed.**
*Reason:* proven in HRestroSewa, cheap to run and simple to migrate. Composite
`(clinic_id, id)` FKs add a database-level guarantee HRestroSewa lacks.
*Alternatives:* schema-per-tenant (migration fan-out, pooling pain) and DB-per-tenant (ops
cost far beyond small clinics) were both rejected for now. DB-per-tenant could be an
enterprise tier later.

**D-04 Data access: server-only via service_role, RLS deny-all backstop, clinical access via
audited RPCs. Proposed.**
*Reason:* the anon key is public, so the browser must have no table access. Putting the
care-relationship check *and* the audit insert in the same SQL transaction makes "read
without audit" impossible. *Alternative:* per-user RLS with JWT claims as the main layer was
rejected for the MVP (`security.md` §6 has the full reasoning) and kept as an option for
future direct-client features.

**D-05 Staff authentication: email/username + strong password + MFA, no PIN as primary.
Superseded by D-27 (2026-11-20, Revision 2). Email/password stays primary, and PIN quick
access is added back as a device-bound layer.**
*Reason:* HRestroSewa's 4-digit PIN fits a POS floor but is too weak for medical records.
MFA scope is P-11. A quick-unlock PIN for shared devices *on top of* a real session is P-06.

**D-06 The Clinic Admin does not implicitly access clinical content. Proposed.**
*Reason:* in HRestroSewa the admin bypasses everything, but in a clinic a non-clinical
manager reading diagnoses is the main insider risk. Admin-doctors get access as doctors.
Others use audited break-glass. The owner-doctor alternative is P-07.

**D-07 One clinic dashboard (`(clinic)`) for admin and staff, gated by permission.
Superseded by D-28 (2026-11-20). The owner requires HRestroSewa's separate Admin and
Employee areas.**
*Reason:* HRestroSewa's split `(admin)`/`(employee)` trees led to thin pages that reuse
admin clients anyway. A single tree with derived navigation is simpler.

**D-08 The Super Admin has no access to patient data. Proposed.**
*Reason:* the platform operator doesn't need PHI, and excluding it shrinks the breach
surface and simplifies the processor role. Support works by clinic-side screen sharing, or
later through clinic-approved audited support sessions.

**D-09 Realtime: Postgres LISTEN/NOTIFY → SSE, topic-only. Proposed.**
*Reason:* proven in HRestroSewa, and it keeps RLS closed to the browser. Clients refetch
through permission-checked actions, so no data travels over the stream.

**D-10 Notifications: outbox + cron dispatcher; PHI-minimal content on every external
channel. Proposed.**
*Reason:* the outbox is written in the same transaction as the event, giving exactly-once
delivery and retries (a generalisation of HRestroSewa's `report_deliveries`). Push, SMS and
email cross third-party infrastructure, so they never carry clinical content.

**D-11 Double booking prevented by GiST exclusion constraints. Proposed.**
*Reason:* the database guarantees it under concurrency, whereas application checks can race.
Uses `btree_gist`.

**D-12 Clinical records are immutable after finalize/issue; corrections are addenda or
cancellations. Proposed.**
*Reason:* medico-legal integrity. The same "edit in place + audit" pattern as HRestroSewa's
Security PIN is **not** appropriate for clinical content.

**D-13 Public site URL: `/c/[slug]` path in the MVP; subdomains in P2; custom domains later.
Proposed.**
*Reason:* one TLS certificate, no wildcard DNS work for the MVP, and the same pattern as
HRestroSewa. Depends on P-01 for the actual domain.

**D-14 Time: UTC storage, clinic timezone (Asia/Kathmandu), AD + BS display, one time
module. Proposed.**
*Reason:* HRestroSewa's `business-day.ts` lesson is that scattered date maths breaks at day
boundaries. The BS conversion library is **[OPEN]** and must be evaluated for correctness
across the supported year range.

**D-15 Deployment: Coolify + self-hosted Supabase, stack separate from HRestroSewa; Kong `/pg`
blocked publicly. Proposed.**
*Reason:* reuse of proven ops, plus isolation from the POS. Blocking `/pg` removes a
superuser-reaching HTTP route that HRestroSewa accepts. Tooling uses an SSH tunnel. Hosting
location is P-02/P-09.

**D-16 Pin exact dependency versions. Proposed.**
*Reason:* HRestroSewa's `latest` ranges make builds non-reproducible. Medical software needs
reproducible, reviewable upgrades.

**D-17 Email through Resend (HTTPS); SMTP only as a dev fallback. Proposed.**
*Reason:* HRestroSewa confirmed its VPS provider drops outbound SMTP.

**D-18 Migration 0001 sets the access posture before any table exists. Proposed.**
*Reason:* HRestroSewa found that hosted and self-hosted Supabase default grants differ in
opposite directions. Making the posture explicit in migrations is the only reproducible
setup.

**D-19 MVP onboarding is Super-Admin-provisioned (invite-only); self-signup in P2.
Superseded by D-29 (2026-11-20). Marketing-site registration is in the MVP, with
Super Admin approval.**
*Reason:* the first clinics need hand-holding and verification. Self-signup brings fraud
and abuse surface.

**D-20 Patients are per-clinic records; no cross-clinic patient identity. Proposed.**
*Reason:* each clinic is the data controller for its own patients. A cross-clinic identity
would need consent and legal grounds that haven't been established. A patient portal (P2)
can link the same phone across clinics later, with consent.

**D-21 No patient data stored at rest on client devices. Proposed.**
*Reason:* shared reception PCs and personal phones. HRestroSewa's no-dynamic-cache service
worker posture already fits.

**D-22 Invoice numbers sequential per clinic per Nepali fiscal year, stamped on issue, never
reused. Proposed. Refined by D-49: the series is per billing profile.**
*Reason:* HRestroSewa's trigger-stamped numbering is proven. Fiscal-year scoping is the
expected Nepali practice (**Assumption**, verify under P-08).

**D-23 Append-only `audit_log`, including reads of clinical data. Proposed.**
*Reason:* "who looked at this patient" must be answerable. A trigger forbids update/delete
for every role.

**D-24 `clinic_members` decouples Auth users from clinics (many-to-many-ready). Proposed.
Refined by D-26: the table is renamed `tenant_members`.**
*Reason:* visiting doctors commonly serve several clinics (**Assumption**). Building the
table now costs nothing, whereas retrofitting it later touches auth everywhere. Whether
the MVP UI exposes it is P-16.

**D-25 Storage: public bucket for logos and doctor photos; private bucket + short-TTL signed
URLs (after care check + audit) for clinical files. Proposed.**
*Reason:* HRestroSewa has only public buckets, which is fine for menus and unacceptable for
clinical documents.

---

## Revision 2 (2026-11-20): owner requirements applied
The owner asked for: five application areas mirroring HRestroSewa, email/password for every
internal account **plus** HRestroSewa's tenant link + PIN access, configurable roles,
pharmacy/inventory/stores/vendors/purchases/sales/expenses/finance in the Admin, a
tenant-managed public website, and patient registration on that website. The decisions
below implement those requirements and are **Accepted in principle** (owner-directed). The
details inside each are **Proposed**.

**D-26 Tenant naming and business types. Proposed.**
The tenant table is `tenants` with `tenant_id` everywhere (formerly `clinics`/`clinic_id`),
because tenants now include clinics with pharmacies and (later) pharmacy-only businesses.
`tenants.business_type` gates modules, as HRestroSewa's `restaurants.type` does with
`hasRooms`. Composite FKs from D-03 are unchanged.

**D-27 Dual authentication: email/password identity + device-bound tenant link/PIN quick
access, with session assurance levels. Accepted in principle (owner requirement); mechanism
Proposed.**
*What HRestroSewa does (verified in `app/actions/auth.ts`):* `/login?mode=staff&slug=` shows
the active staff list of the restaurant to **anyone** who has the slug (and `searchRestaurants`
finds slugs). The 4-digit PIN **is** the Supabase password of a synthetic account
`emp-<id>@restrosewa.internal`, so the person has no other credential. There is a DB-clock
lockout of 5 failures → 30 min per person, and admins sign in by PIN as well.
*What CMediSewa does:* every internal user has one Supabase identity with email (or
username, P-18) + password. The PIN is a separate hashed secret (`member_pins`) that works
only on admin-enrolled **trusted devices**. After `verify_pin` succeeds, the server mints a
normal session for that same identity (P-23) and records **A1** in `session_assurance`.
Password sign-in gives **A2**, and MFA gives **A3**. Operations declare a minimum level
(`permissions.md` §3). **PIN alone never opens clinical records, the Admin area, money
corrections or permission changes.** One session per device (switching user signs out
locally first), so sessions never conflict.
*Why:* it keeps HRestroSewa's proven speed on shared front-desk and counter devices while
closing its three weaknesses for medical data: public staff enumeration, a short PIN as the
only credential, and no separation between quick access and full authentication.
*Alternatives rejected:* PIN as the Auth password (HRestroSewa model), because it means two
credentials per person or a weak single credential; PIN on any device, because it brings
back enumeration and remote brute force; no PIN at all, because it was rejected by the owner
and is slow at shared counters.

**D-28 Five areas with separate Admin and Employee route groups (HRestroSewa structure).
Accepted in principle.**
`(marketing)`, `(superadmin)`, `(admin)`, `(employee)`, `(public)/c/[slug]`. The admin layout
admits any active member at A2+ and each page guards its own permission (HRestroSewa rule).
The employee area is a role-based workspace at A1+. Both share the same client components
and actions, so there are no duplicate screens.

**D-29 Marketing-site registration → email verification → Super Admin approval →
provisioning, in the MVP. Accepted in principle.**
Instant self-serve activation stays P2 (M-38), because manual approval limits fraud while
the first tenants onboard.

**D-30 Configurable tenant roles; professional credentials gate clinical keys. Proposed.**
`tenant_roles` (seeded from templates, editable, custom roles allowed) + multi-role
assignment + per-member overrides. Clinical and dispensing keys are effective only with a
matching verified credential. *Why:* the owner asked not to hardcode roles, and a
credential gate keeps a mis-configured custom role from handing out clinical access.
*Rejected:* a fixed `staff_type` enum (the Revision 1 plan), because it is too rigid for
mixed roles like "receptionist + cashier".

**D-31 Patient accounts are optional, per tenant, OTP-based, with app-managed sessions;
clinical documents require a reception-verified link. Proposed.**
Guests can book with no account (manage link). An account adds history, family members and
saved details. Accounts live in `patient_accounts` per tenant (consistent with D-20), not in
`auth.users`. The session is a hashed `patient_sessions` cookie scoped to `/c/[slug]`, so it
can't collide with staff Supabase sessions. *Rejected:* required patient accounts, which add
friction for first-time bookers who are often on phones; Supabase Auth for patients, which
mixes patients into the staff identity store and gives them one global identity across
tenants.

**D-32 Inventory is an append-only movement ledger per store × batch; stock is derived.
Proposed. Refined by D-38 (2026-11-20, Revision 3): the ledger stays the source of truth,
plus a trigger-maintained balance cache with a DB `CHECK ≥ 0`.**
It adapts HRestroSewa's derived-stock decision ("never store `current_stock`") to batches,
expiry and multiple stores. Negative stock is prevented by advisory-locked RPCs, and expired
batches are refused. A verified cache table is allowed later only if measured slowness
requires it.

**D-33 Finance is HRestroSewa's derived model: four balances (cash, bank/online, receivable,
payable) from source rows + one opening seed. Proposed. Refined by D-43 (Revision 3): the
same four balances become accounts of a double-entry journal written by the posting
transaction, and the HRestroSewa-style derivation is kept as the nightly reconciliation
(P-26).**
Vendor payables are **derived** (HRestroSewa stores `vendors.credit_balance` and moves it
only through RPCs; CMediSewa applies the "never store derived" rule strictly). Expenses use
HRestroSewa's `extra_expenses` shape.

**D-34 The public website is tenant-managed content, published from the Admin. Proposed.**
It is the analogue of HRestroSewa's admin-managed menu feeding `/c/[slug]`. Typed
`site_settings` + announcements/media/FAQs, sanitised Markdown with no raw HTML, a draft
preview and a re-auth-gated publish, and cache revalidation by tenant tag.

**D-35 One invoice pipeline for services and items; issuing writes stock-out in the same
transaction. Proposed.**
It avoids separate clinic and pharmacy billing that would split finance, numbering and
patient dues.

**D-36 Platform billing: platform invoices + manual payment recording in the MVP. Proposed.**
It generalises HRestroSewa's `install_date`/extra-days subscription into explicit
subscription periods and invoices. A gateway comes later (P-12).

**D-37 Separate hosts: `<domain>` (marketing + tenant sites) and `app.<domain>` (Admin,
Superseded by D-59 (2026-11-20, owner): one host, as in HRestroSewa.**
**Original text:**
Employee, Super Admin). Proposed.**
Staff session cookies are host-only on `app.`, so they are never sent to pages that render
tenant-authored public content. This refines D-13 (the path `/c/[slug]` remains).

---

## Revision 3 (2026-11-20): inventory, pharmacy, purchasing, sales & finance
Based on HRestroSewa's actual implementation (verified in `supabase/migrations/
20260711200000_stock.sql`, `…300000_purchases.sql`, `…300001_purchase_functions.sql`,
`20260825100000_extra_income.sql` `finance_transactions`, `lib/payment-split.ts`):
- products have one free-text unit with no conversion, `last_unit_cost`, `opening_stock`
  and `low_stock_threshold`; there are no batches, expiry or stores;
- stock is derived from opening + purchases − recipe usage ± signed adjustments;
- `record_purchase` computes totals on the server, locks the vendor row, numbers with an
  advisory lock + `max()+1`, enforces CHECK cash + online + credit = total, and moves a
  stored `credit_balance`;
- finance is a union of source tables into four balance deltas (card = bank), and profit is
  "estimated" because cost is approximate.
All entries below are **Proposed**.

**D-38 Stock = append-only movement ledger (source of truth) + a trigger-maintained
`stock_balances` cache with `CHECK (qty_on_hand >= 0)`.**
*Why:* with lots × stores × concurrent counters, the database needs a row to lock and a
constraint that makes negative stock impossible, not just an application check. Advisory
locks plus a re-sum (the Revision 2 plan) work but leave the invariant to code.
*Kept from HRestroSewa:* the ledger, not the cache, is authoritative. Nightly reconciliation
can rebuild the cache at any time.
*Alternatives:* pure derivation (Revision 2: correct but no DB-level non-negative guarantee,
and slower aggregation); a stored mutable `current_stock` per item (rejected: it loses batch
and store identity and invites manual edits).

**D-39 Ledger tables are writable only by posting functions.** `stock_movements` and
`ledger_entries` accept inserts only from `SECURITY DEFINER` functions owned by a non-login
`ledger_writer` role. Every other role, including `service_role`, has no INSERT, UPDATE or
DELETE on them. *Why:* this enforces the requirement that stock can't change without a proper
movement record in the database itself, not just by convention.

**D-40 FEFO is the default allocation (FIFO as the tie-break); manual override needs
`override_batch`; expired and blocked lots can never be allocated.**
*Why:* medicine value is lost at expiry, not by arrival order. A later delivery can expire
sooner, so FIFO would knowingly sell long-dated stock while short-dated stock expires. FIFO
stays available as a setting for non-medicine stores.

**D-41 Lot per receipt; all stock in base units with per-unit conversion factors.**
One `item_batches` row per purchase line (or opening/found entry), carrying batch no., mfg,
expiry, exact cost, MRP and sale price. A new purchase never overwrites an existing lot. A
"batch" in reports groups lots by `(item, batch_no)`. A batch-no/expiry mismatch is flagged.
Units: the base unit is the smallest unit sold, factors are locked once used, and lines
snapshot the factor. *Why:* exact COGS, no expiry overwrite, loose-tablet sales.
*Alternative rejected:* one row per batch number with weighted-average cost, which blurs cost
and needs updates on every receipt.

**D-42 A sales line spans lots through `invoice_line_allocations` (one allocation = one lot =
one `sale` movement), each with its own price and cost.**
*Why:* the user asked how a multi-medicine, multi-batch sale is recorded. Per-lot allocations
preserve batch-wise sales and returns history, exact COGS, and recall traceability to the
patient. *Alternative rejected:* forcing one lot or one price per line.

**D-43 Finance is a double-entry journal (`ledger_entries`) written in the same transaction
as each posting, with a fixed system chart of accounts and store, party and channel
dimensions.**
*Why:* more document types (purchases with returns and allocations, multi-lot sales, returns,
transfers in transit, losses) would make HRestroSewa's single union query grow special
cases (its `advance_amount` lockstep is an example). A journal makes every posting's
financial effect explicit, gives exact P&L and store-wise reports by summing accounts, and
keeps carry-forward drift impossible. The HRestroSewa-style document derivation remains as
`verify_finance_integrity`. *Alternative:* pure derivation as in HRestroSewa, kept open as
**P-26**.

**D-44 Every stock or money change is an idempotent posting with gapless numbering.**
`postings(idempotency_key)` is unique per tenant. A retry returns the original result.
`document_sequences` row-locked per (tenant, doc type, fiscal year). *Why:* double taps,
flaky Nepali mobile networks and PWA resubmits are routine. HRestroSewa's advisory lock +
`max()+1` is safe but not gapless under deletes and gives no retry protection.

**D-45 Posted documents are immutable; corrections are reversals or returns.**
This departs from HRestroSewa's Security-PIN in-place edits (`edit_purchase`,
`edit_payment_tender`). *Why:* medicine stock has batch traceability and regulatory
exposure, and in-place edits rewrite history that sales may already depend on. A sales void
is allowed only on the same business day. A purchase void only while its lots are untouched.
Everything else goes through returns or reversal postings with re-auth and audit.

**D-46 Inventory permissions are store-scoped through `store_members` (view/operate/manage);
`all_stores` and `tenant_admin` see every store.** It is HRestroSewa's strict assignment
rule applied to stores. Item master, prices, vendors and finance stay tenant-wide.

**D-47 Controlled and narcotic medicines are blocked from sale until the controlled-drug
register (M-48) exists and P-22 is answered.** *Why:* selling them without the record-keeping
the law may require is a risk the platform shouldn't create by default.

**D-48 Vendor payables and patient dues are not stored balances.** They are journal account
balances by party, cross-checked against the documents. Payments carry explicit
**allocations** to invoices (FIFO by default, HRestroSewa's settlement rule), so the
outstanding amount per invoice is exact and ageing reports are possible.

---

## Revision 4 (2026-11-20): integration audit
All entries below are **Proposed**.

**D-49 Billing profiles: one invoice = one billing profile (+ at most one store); numbering
per profile.** A clinic and its in-house pharmacy often hold separate registrations and PAN
in Nepal (**Assumption**, P-29). Profiles hold legal name, PAN, registration no., address and
invoice series. A visit can therefore have a services invoice and a pharmacy invoice that
both reference the same visit and patient, and the patient balance sums across them.
Purchases also carry the buying profile. *Refines D-22* (numbering is per profile per fiscal
year, not per tenant). *Alternative rejected:* one invoice per visit mixing both entities,
which would be invalid if they are separate taxpayers.

**D-50 Module registry + tenant toggles.** `lib/modules.ts` is the single source.
Effective module = business type ∧ plan ∧ tenant toggle ∧ dependencies. A disabled module is
not navigable, grantable or postable (`MODULE_DISABLED`). Toggling never deletes data. *Why:*
"don't force every clinic to use every module". It generalises HRestroSewa's `hasRooms`.

**D-51 Consultation-fee billing point is a tenant setting (`check_in` | `checkout` | `none`),
and services invoices are created by the check-in/checkout RPCs, never re-keyed.** *Why:*
Nepali OPDs often sell a prepaid ticket at registration (**Assumption**), while others bill
at checkout. P-31 sets the default.

**D-52 A professional credential must be verified by someone other than its holder.** Another
tenant admin verifies, or the Super Admin for single-admin tenants (they see name, profession
and registration no. only). Every change notifies all admins. *Why:* the audit found that an
admin could self-grant a doctor credential and get round D-06.

**D-53 The posting core is part of MS0 Foundation.** *Why:* the audit found that R1 issued
service invoices before the journal existed (R2 step 14), which would have created
un-journaled money. No document that moves money or stock may exist before the posting core.

**D-54 Roadmap = dependency-ordered milestones MS0–MS13 with two pilot gates. Superseded by D-55.** Gate A (after
MS6) = clinic without pharmacy. Gate B (after MS11) = clinic + pharmacy. R1 = MS0–MS6 and
R2 = MS7–MS11, so older references stay valid.

---

## Revision 5 (2026-11-20): owner answers on structure and phases
Owner statements: every clinic has its **own pharmacy**, run by a person who handles stock,
billing and the counter. Clinics have a **registrar**, **OPD doctors**, a **lab** and other
staff. Dashboards are needed for **Admin, Pharmacy, Registrar, Lab (Phase 3)**, plus a
**Doctor OPD dashboard** (chosen). The pharmacy bills under the **same PAN/registration**,
and billing is done by staff with permission. The **OPD fee is collected at registration**.
Phase 0 = database + backend. Phase 1 = UI outline + MVP. Lab in Phase 3.
These are **Accepted (owner)**.

**D-55 Phases: Phase 0 backend, Phase 1 UI + MVP, Phase 2 next features, Phase 3 lab.
Supersedes D-54.** Backend milestones B0–B9, UI milestones U1–U8, one pilot gate at the end
of Phase 1. *Trade-off accepted:* building the backend before the UI risks API/screen
mismatch, mitigated by workflow-driven, executable tests (W-31 as a script) and an early
clickable outline (U1). D-53 (posting core first) is kept as B0.

**D-56 Four staff dashboards: Admin, Registrar, Doctor OPD, Pharmacy (Lab in Phase 3).**
The Admin dashboard is the `(admin)` area. Registrar, OPD, Pharmacy and Lab are role
workspaces in the `(employee)` area (`/employee/registrar`, `/employee/opd`,
`/employee/pharmacy`, `/employee/lab`), each a role template's home. Other staff get
custom roles that reuse these workspaces with fewer permissions. Roles stay configurable
(D-30). *Refines D-28.*

**D-57 The Pharmacy role combines pharmacist, cashier and inventory manager.** One template
covers dispensing, OTC sales, pharmacy billing and payments, stock (receive, transfer,
count, adjust, quarantine), purchases and vendors. Money-moving and stock-correcting
operations still need A2 (password), and some need re-auth (`permissions.md` §3), so PIN
quick access covers only counter work. The admin can remove keys (e.g. vendor payments) per
clinic.

**D-58 Launch configuration: business type `clinic_pharmacy`, one billing profile (same PAN),
OPD fee at registration.** It resolves **P-21** (launch with clinic + pharmacy; clinic-only
and pharmacy-only later), **P-29** (one profile; the second-profile capability stays in the
schema), **P-31** (`consultation_billing_point = check_in`, by the registrar) and **P-17**
(one pilot gate, clinic + pharmacy). With one profile, the OPD bill and the pharmacy bill
are separate invoices in the same series (one invoice = one store rule, D-49).
Provisioning creates a **Pharmacy** store (sellable, receiving, dispensing) and a quarantine
store. A main or department store is optional.

---

**D-59 One host for all five areas, as in HRestroSewa. Accepted (owner), supersedes D-37.**
`<domain>/` marketing · `/c/<slug>` tenant sites · `/login`, `/login/<slug>` sign-in ·
`/admin/*` · `/employee/*` · `/superadmin/*`, in one Next.js app on one origin.
*Trade-off accepted:* the staff session cookie is also valid on public pages, so a script
bug on a public page could act as a signed-in staff member in that browser.
*Safeguards:* sanitised Markdown with no raw HTML in tenant content; a strict CSP with nonces
on **every** page; Next's Server Action origin check; HttpOnly, SameSite=Lax cookies; patient
sessions in a separately named cookie (`cm_patient`) scoped to `/c/<slug>`; staff book from
the Registrar dashboard rather than the public site. Subdomain tenant sites (P2) or a split
host can be revisited later without data changes.

---

## Phase 0 / B0 implementation decisions (2026-11-20)
**D-60 Bikram Sambat data: `nepali-date-converter` 3.4.2 at runtime, cross-checked against
`bikram-sambat` 1.8.1.** Both agree on every day from 2013 to 2033 (unit test) and on every
fiscal-year start (the generator refuses to write if they disagree). The DB holds fiscal
years as a generated reference table (`fiscal_years`, FY 2070/71–2089/90) used by
`fiscal_year_of()`. *Limit:* both libraries end at 2090 BS (≈ AD 2033), so a new migration
must extend the table before 2032. *Resolves the [OPEN] in D-14.*

**D-61 Tooling targets declare themselves (`APP_ENV`); Supabase new-format keys.** The
migration runner and DB tests refuse any env file without `APP_ENV`. Production writes need
`--prod --yes` **and** `APP_ENV=production`. There is no hostname or project-ref guess
(HRestroSewa's `PROD_REF` went stale). Env names follow Supabase's new keys:
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` (deployment.md §5). No
Kong-HTTP mode: production is reached over an SSH tunnel (D-15).

**D-62 Pinned toolchain (D-16 applied).** Next 16.4.5, React 19.3.1, TypeScript **6.0.3** (not
7.x: Next 16 + TS 7 is unproven, and HRestroSewa runs 6.0.3), ESLint **9.39.5** (the plugins in
`eslint-config-next` 16.4.5 do not support ESLint 10), supabase-js 2.119.0, @supabase/ssr
0.12.7, pg 8.23.1, Tailwind 4.3.4. Each is the newest stable release at least 14 days old
on 2026-11-20.

**D-63 Access posture findings from the dev project, enforced by migrations 0001 + 0006 and
`scripts/lib/posture.mjs`.** By default, objects created by `postgres` grant
`anon`/`authenticated` TRUNCATE, TRIGGER, REFERENCES and MAINTAIN (TRUNCATE bypasses RLS),
give `service_role` no DML, and give functions EXECUTE. After 0001/0006: anon and
authenticated hold nothing, service_role holds plain DML only, no function is executable
unless granted explicitly, and `ledger_writer` owns the posting primitives (it held CREATE
only for the moment of the ownership transfer). The posture check runs in CI and in the
DB test suite.

---

**D-64 Development runs locally and on Vercel against the hosted dev database; self-hosting,
PWA, mail and similar infrastructure come later. Accepted (owner, 2026-11-20).** The
Coolify/self-hosted plan (D-15, deployment.md) stays as the production target, but nothing
in it is built yet. Consequences: `output: "standalone"` is removed until self-hosting; the
Vercel project uses the same env names as `.env.local` (set in the Vercel dashboard by the
owner); **Vercel functions cannot hold the long-lived LISTEN connection + SSE stream** of
D-09, so realtime (B9) either runs its fallback poll on Vercel or waits for the self-hosted
server. That will be decided at B9. Cron jobs on Vercel would use Vercel Cron rather than
pg_cron → route, also decided when the jobs are built.

**D-65 Phase 1 UI outline (U1) started before backend B1, by owner direction.** The screens
are laid out with clearly labelled **demo data** (`lib/demo.ts`). Every outline screen shows
a demo notice, and no form submits. Each screen is wired to real Server Actions when its
backend milestone lands (B1 sign-in, B3 setup, B4 registrar/OPD, B5–B7 pharmacy, B8 finance).
This keeps the D-55 rule that UI must not invent its own data paths.

**D-66 Visual identity (U1).** Cool off-white canvas, **pine** (#0f5c4d) as the working
colour, **marigold** (#e9a514) as the single bold accent reserved for tokens and queue
numbers, and red, amber and green used only for meaning. **Mukta** is the only typeface,
because it is designed for Devanagari and Latin together. The signature element is the
**OPD ticket** (a punched token slip). Deliberately avoided: a dark sidebar, all-caps eyebrow
labels, and identical KPI-card grids. Details are in ui-ux.md §12.

---

## B1 Identity & access (2026-11-20, owner: "use your recommended defaults")
**Accepted (owner):** P-11, P-18, P-19, P-30 resolved with the recommended defaults (below).

**D-67 PIN quick access mints a normal session server-side (P-23 resolved).** After
`verify_pin` succeeds in SQL, the server calls `auth.admin.generateLink(magiclink)` and
`verifyOtp({ token_hash })` on the cookie-bound client. The spike on the dev project (2026-11-20)
showed: about 240 ms; works for username accounts' internal addresses with no email sent; the
token is single-use; the session is `aal1`, refreshes normally and signs out locally. The
fallback (PIN-as-unlock only) is not needed. The session is recorded as **A1** in
`session_assurance`.

**D-68 B1 implementation choices.**
- (a) Permissions, modules and role templates are generated into SQL catalog tables from
  `lib/permissions.ts` / `lib/modules.ts` (migration 0009, `scripts/gen-permission-catalog.mjs`),
  with a TS/SQL parity unit test. `effective_permissions()` / `effective_modules()` in SQL
  mirror the TS.
- (b) `resolve_request_context()` returns membership, tenant, permissions, modules and session
  assurance in one round trip.
- (c) PIN hashes are bcrypt (pgcrypto) in `member_pins`, and service_role cannot read them. The
  lockout is 5 → 15 min per member and 20 failures per hour per device, judged by the DB
  clock.
- (d) Trusted devices are cookie tokens whose HMAC (`AUTH_HMAC_SECRET`) alone is stored.
- (e) App-level password lockout: 10 failures in 15 min. Logins are hashed with HMAC and never
  stored raw.
- (f) A step-up re-checks the password on a throwaway client and raises the CURRENT session's
  level (no second session).
- (g) Tenant slugs that would shadow app routes are reserved in the DB (migration 0013).
- (h) Username accounts use internal auth addresses `m-<member_id>@users.cmedisewa.internal`.
- (i) Development seed: `scripts/seed-dev.mjs` creates the demo clinic `arogya-demo`, with
  credentials written only to gitignored `scripts/dev-users.local.json`.

---

## B2 Platform (2026-11-20)

**D-69 Without email (D-64), onboarding uses review + one-time links.** Applications are not
email-verified. The platform admin reviews (and phones) each one, protected by a honeypot,
5 per IP per day, and one open application per email. The tenant admin invite is a **one-time
link** (HMAC-hashed, 7 days) shown once to the platform admin to share. Accepting it creates
the auth account, links it in one DB step (deleting the account again on failure), and goes
straight to 2FA. Email verification and emailed invites replace these when mail is set up.

**D-70 Subscriptions are append-only periods; "paid until" follows the chain of back-to-back
periods.** Renewals added in advance count immediately, and a gap breaks the chain. The
expiry job (`suspend_expired_tenants`, `POST /api/cron/subscriptions` with `x-cron-secret`)
suspends only ACTIVE clinics, with reason `subscription_expired`. A new period re-activates only
those. Manual suspensions stay until a platform admin changes them. Scheduling the job
(pg_cron or Vercel Cron) comes with hosting.

**D-71 Platform invoices and payments are separate from clinic money.** Numbered
`CMS-<FY>-NNNN` (gapless per Nepali fiscal year), payments can't exceed the balance, the
balance is derived, and only SECURITY DEFINER functions write them. Plan features
(`plans.features`) now feed `effective_modules()` (lab etc.).

**D-72 Provisioning creates the clinic's first stores** (`stores` table introduced early in
B2): **Pharmacy** (sellable, dispensing, receiving) and **Quarantine** (never sellable), per D-58.
B5 adds lots, balances and store members on top.

---

## B3 Tenant setup (2026-11-20)

**D-73 OPD schedules are weekly windows with effective dating, each either time slots or
tokens** (P-03 "both"). Overlaps per doctor/weekday are impossible (exclusion constraint).
Removing a window closes it yesterday instead of deleting history. Leave (whole or part day),
extra OPD and changed-hours days are exceptions. `available_slots()` turns them into
Kathmandu-time slots or token sessions; B4 subtracts bookings.

**D-74 The public clinic page reads ONE allow-listed function, `public_clinic_profile(slug)`.**
It returns data only for an active clinic with a published website. Doctors are listed only
when public and holding a verified, unexpired doctor credential. Prices and registration
numbers can be hidden by the clinic. Website content is plain text, never HTML.

**D-75 Staff join by one-time invite links, like the clinic owner (D-69).** Username-only staff
(P-18) get an internal auth address `m-<member_id>@users.cmedisewa.internal`. Admins and
doctors go to 2FA after joining; other staff go straight to their workspace.

**D-76 Assurance per screen action:** catalogue, schedules and website edits need the Admin
area (A2). Settings and go-live need a password confirmed within 5 minutes. Staff, roles and
credential verification need A3 (password + authenticator) within 5 minutes. Pages can be
viewed without the step-up; saving asks for it.

**D-77 Go-live is the clinic admin's step, gated by `go_live_blockers()`:** clinic phone,
bill header legal name, and (by plan modules) a consultation service, a doctor with an OPD
schedule, and a pharmacy store. Editing a credential's council or number clears its
verification; custom roles are saved through the audited `save_role()`.

---

## B4a Front desk (2026-11-20)

**D-78 B4 is delivered in three slices:** B4a front desk (patients, booking, check-in with the
OPD fee, queue), B4b doctor (encounters, vitals, diagnoses, prescriptions, care predicate,
audited reads), B4c public booking + manage link. OTP patient accounts wait for SMS/mail (D-64).

**D-79 Appointments always carry a time range.** Slot mode: the slot. Token mode: the whole
session, shared up to its capacity (counted under a transaction advisory lock). Exclusion
constraints stop double-booking a slot and a patient holding two overlapping bookings.
Tokens are issued at check-in (per doctor per day, row-locked counter), not at booking.
A doctor can send a called patient back to the queue.

**D-80 Check-in is ONE posting RPC (`check_in_visit`, owned by ledger_writer):** visit + token
+ OPD invoice + payment + both journal postings, or nothing. Idempotent on a client key
(a double-click returns the first token). Fee = doctor_services override, else the
doctor's consultation fee for a consultation service, else the service price. Desk discount
is capped by `max_discount_pct_without_reauth`; dues only with `allow_credit` within the
per-patient limit. Invoice/receipt numbers are gapless per billing profile per fiscal year.
Money tables are read-only to the app role.

**D-81 Patients:** MRN is a 6-digit per-clinic series stamped by trigger and immutable. A
possible duplicate (same phone + first name, or same name + birth date) is flagged for the
desk, never merged automatically. The app may update demographics only (column grants).

---

## Website booking and payments (user direction, 2026-11-20)

**D-82 Website booking is a REQUEST, approved by staff (B4c, after B4b).** A patient on the
clinic page can only send a booking request (name, phone or Gmail, preferred doctor and
time). It appears to the Registrar and the Admin as a request. Staff contact the patient by
the phone number or Gmail given, then approve (confirmed) or decline (with a reason). Online
bookings are never auto-confirmed (`auto_confirm_online` is ignored for website requests).
The requested time IS HELD while the request is open (other visitors see it taken);
unreviewed requests are released once their time has passed. A request does not create a
patient record: on approval the registrar links it to an existing patient (searched by phone)
or registers a new one, which avoids junk and duplicate MRNs. The patient sees the status
(requested / confirmed / declined) on their request link until SMS or mail exists.

**D-83 No payment gateway integration.** No eSewa/Khalti/Fonepay/card gateway, and no online
payment from the website. Online money is recorded by staff at the counter (channel +
reference) as built in B4a.

---

## B4b Doctor (2026-11-20)

**D-84 Clinical data is reachable ONLY through care-checked functions.** Stronger than
security.md §4: the app role holds no privilege on encounters, vitals, diagnoses,
prescriptions, allergies, addenda or grants. Every read/write goes through SECURITY DEFINER
functions that evaluate `clinical_scope()` (permissions.md §6 C1–C6; C7 pharmacist arrives
with dispensing in B7), refuse PIN sessions (A1), and audit. A refused READ is returned (not
raised) so its audit row persists; a refused WRITE is logged by the app (`lib/clinical.ts`)
because the database row rolls back with the call.

**D-85 C3 is per clinic visit, not per doctor:** while a patient is waiting or with a doctor
today, any doctor or nurse with a verified registration and `record_vitals` may record vitals
and allergies (vitals scope; never notes or prescriptions). Notes are written only by the
treating doctor; another doctor's unfinished draft is never shown.

**D-86 Encounter lifecycle:** one draft per visit, opened when the doctor calls the patient.
"Finalize" saves, issues the prescription (RX-000001, a per-clinic series), finalizes the note
and closes the visit. Finalized notes, issued prescriptions, vitals and addenda are immutable
by trigger (even for the owner role); corrections are addenda; an issued Rx can be cancelled
with a reason. Prescription lines store the printed medicine text; the link to inventory items
(`item_id`) is filled from B5.

---

## B5a Inventory core (2026-11-20)

**D-87 B5 is delivered in three slices:** B5a item master, lots, ledger + balances, opening
stock, FEFO allocation, store access; B5b transfers, adjustments, counts, block/recall,
quarantine and disposal; B5c alerts, purchase suggestions and nightly reconciliation.

**D-88 Item master is written only through `save_item()`** (item + medicine details + units +
barcodes in one audited transaction). Generics, categories and manufacturers are per clinic,
found-or-created by name with suggestions (P-24 default: no platform list yet). Unit sizes
and the base unit are frozen once the item has any lot; new units can still be added.

**D-89 Stock posting rules as built:** every quantity change is a `stock_movements` row written
by a ledger_writer function; `stock_balances` is maintained only by trigger and can never go
negative (CHECK). Posting stock needs A2, `manage_stock` and **Manage** access to the store
(clinic admins and `all_stores` holders manage every store). Opening stock creates one lot per
line, converts to base units, refuses a known batch number with a different expiry unless a
reason is given, refuses a sale price above MRP (P-25 default), and posts Dr INVENTORY /
Cr OPENING_EQUITY. FEFO (`allocate_stock`) skips expired, blocked/recalled and short-dated lots.

---

## B5b Stock operations (2026-11-20)

**D-90 Transfers are request → (approve) → send → receive, with no partial receipt.** Approval
only when `transfer_approval_required`; approving needs `approve_transfers` + Manage on the
source. Sending takes FEFO sellable lots, or a named lot; only sellable lots may enter a
sellable store, while expired/blocked lots may go to quarantine. Receiving must account for
every unit as received or lost (with a reason); transit is posted Dr INVENTORY_IN_TRANSIT /
Cr INVENTORY, receipt Dr INVENTORY, loss Dr INV_LOSS, so transit always nets to zero. Any
store can send to quarantine (it isn't "receiving" for purchases or opening stock).
"To quarantine" on a lot runs request, send and receive in one click.

**D-91 Adjustments, counts, block and disposal as built:** adjustments need a reason (losses
negative only, "found" positive and may create a lot) and post to INV_LOSS / INV_GAIN. Counts
record each lot with the ledger quantity at that moment, so sales during a count don't make
false differences; one open count per store; blind by default; optional rule that someone
other than the counter posts. Block/recall applies in every store with a reason and history.
Disposal only from quarantine, with method and witness, posted to INV_LOSS. Stock posting
needs A2, the permission key, and Manage on the store; sending and receiving need Operate.

---

## B5c Stock alerts and reconciliation (2026-11-20)

**D-92 Alerts and purchase suggestions are computed on demand, not stored.** `stock_alerts()`
returns expired lots, blocked/recalled lots on hand, near-expiry lots (critical inside the
critical window) and critically-low / reorder stock per store (a store's own levels in
`store_item_levels` override the item's); quarantine never alerts. `purchase_suggestions()`
orders up to the maximum (else the reorder quantity) in whole purchase units at the latest lot
cost; B6 purchase orders start from it. Push/email notification of alerts comes with B9.

**D-93 Nightly reconciliation:** `reconcile_stock_balances()` compares every balance with
Σ stock_movements, rebuilds any difference from the ledger, records the run in
`stock_reconciliations` and writes an audit row (outcome = error) when something was repaired.
`POST /api/cron/stock` (x-cron-secret) runs it for every clinic; Admin → Reorder can run it now.

---

## B6a Purchasing (2026-11-20)

**D-94 B6 is delivered in two slices:** B6a vendors, purchase bills into new lots, vendor
payments and statements; B6b purchase orders (from Reorder), purchase returns with credit
notes or refunds, and nightly payable reconciliation.

**D-95 Purchase bills as built:** totals are computed in SQL from the lines (client totals
ignored); each line creates a NEW lot whose cost = (line net − its share of the bill discount)
÷ (paid + free base units); VAT is recoverable input tax (P-08 default) posted to
TAX_RECEIVABLE, not into lot cost; the same vendor bill number can't be entered twice (unless
the first was voided); medicines need an expiry after the bill date, and a shelf life below
`min_receive_shelf_days` needs a reason. Journal: Dr INVENTORY + Dr TAX_RECEIVABLE / Cr CASH,
BANK, AP_VENDORS. A posted bill is immutable; void (A2 + password within 5 minutes) only
while none of its lots has moved and nothing was paid against it.

**D-96 The payable is never stored.** It is the AP_VENDORS journal balance per vendor; a bill's
outstanding = its credit part − payments allocated to it. A vendor's opening balance is an
"opening" bill (Dr OPENING_EQUITY / Cr AP_VENDORS) so payments settle it like any bill.
Payments settle the oldest bills first (or chosen bills); any remainder is a vendor advance.

---

## Direct clinic creation (user request, 2026-11-21)

**D-97 The Super Admin can create a clinic directly** (Clinics → Add a clinic), modelled on
HRestroSewa's "New restaurant" page. It is recorded as a `direct` application and provisioned
by the same `provision_tenant()` in one transaction (`create_tenant_direct`), so a direct clinic
is identical to an approved one. Unlike HRestroSewa (where the Super Admin sets staff PINs), no
one but the clinic admin ever knows their password: the Super Admin gets a one-time setup link
(7 days) and the clinic's sign-in address `/login/<clinic>`. The admin sets a password and 2FA,
then adds staff from Staff & roles. An email already administering a live clinic is refused.

**D-98 Staff of a clinic that isn't live yet** see a "not live yet" page; only the clinic admin
enters the Admin area to finish setup. (Sending staff to /admin bounced them back in a loop.)

---

## B6b Orders, returns, payable check (2026-11-21)

**D-99 Purchase orders hold no received quantity.** What was received on an order line is
derived from the non-void bills whose lines reference it (`po_line_received`); the order's
status (open → part received → received) is recomputed when a bill is posted or voided.
An order is cancelled only before anything arrives, otherwise closed with a reason. Orders
can be started from Reorder suggestions (one order per store).

**D-100 Purchase returns as built:** only lots bought from that vendor; when a bill is named,
only its lots and no more than it brought in minus earlier returns; expired, blocked and
recalled lots can go back. Value = lot cost plus the VAT paid on it (reversed from
TAX_RECEIVABLE). Credit note: settles open bills (the named bill first, then oldest), any rest
is a vendor advance; refund: cash or bank in. A bill with returns can't be voided.

**D-101 Payable check:** per vendor, journal AP_VENDORS = Σ bills' outstanding and journal
VENDOR_ADVANCES = unapplied payments + unapplied credit notes. A difference is never
"repaired" (the journal is the record); it is logged (audit outcome = error) and shown on
Vendors. It runs nightly with the stock check (`/api/cron/stock`) and on demand.

---

## B7a Pharmacy counter (2026-11-21)

**D-102 Counter sale as built:** one bill line per item; each line takes stock from one or
more lots (earliest expiry first, or a chosen lot with `override_batch`), each lot at its
own sale price, recorded in `invoice_line_allocations`. The bill shows the average rate.
Cost of goods = the lots' own cost, so COGS and INVENTORY in the accounts always equal the
stock ledger. Stock out, the bill, the receipt and both journal postings happen in one
transaction (`issue_counter_sale`), retry-safe by idempotency key. Dues need a linked
patient, the clinic's credit setting and `allow_credit`, within the credit limit.

**D-103 Prescription medicines at the counter:** a prescription-only item is sold either
against an issued internal prescription for the same patient (`dispense_prescription`,
a verified pharmacist) or with an outside prescription recorded on the bill (prescriber,
NMC no., facility, date; `sell_prescription_only`). Controlled and narcotic items are
refused until P-22. A prescription item counts as dispensed once a non-void bill line
references it; items not yet dispensed keep the prescription in the queue.

**D-104 Dispensing queue (C7):** issued prescriptions of the last 14 days with something
left to dispense, showing only the prescription items and the patient's allergies (never
notes or diagnosis). Only verified pharmacists see it; every read is audited.

---

## B7b Returns, void, dues (2026-11-21)

**D-105 Customer returns as built:** only against the original bill, per lot it sold, never
more than sold minus earlier returns. Value = qty × that lot's own sale price, less the
line's discount share, plus its VAT. Each lot goes back on the shelf (only if active,
unexpired and not cold-chain; P-22 default), to quarantine, or is destroyed (cost stays in
COGS). Settled by cash/online refund (a negative receipt, no more than was paid) or by
reducing the bill's due (no more than it owes). Needs `sale_returns` and a password
confirmed in the last 5 minutes.

**D-106 Void as built:** the whole bill, same business day (`day_closing_hour`), only while
nothing was returned against it, `void_invoices` + password in the last 5 minutes. Stock
goes back to the same lots and stores, the sale's journal is reversed, and each payment's
share is refunded in the legs it came in (cash / the same online channel). A voided bill's
prescription items return to the dispensing queue.

**D-107 What a bill owes** is derived, never stored: total − returns − net payments
(`invoice_outstanding`). Dues are collected oldest bill first within the oldest bill's
billing profile (`collect_patient_dues`), never more than owed, at the counter (A1) by
anyone with `manage_billing` or `pharmacy_sell`.

---

## B8a Finance (2026-11-21)

**D-108 Expenses and other income as built:** recorded as of now (no back-dating), cash/online
split, optional store tag (expenses). Other income needs `manage_expenses` and a password
session. A mistake is never edited: it is cancelled by a reversal posting (`manage_expenses`
+ password in the last 5 minutes) and stays listed as cancelled; the right one is recorded
anew. "Cancelled" is derived (a posting that reverses it exists), never a stored flag.

**D-109 Opening balances:** opening cash and bank once per clinic (Dr CASH/BANK, Cr
OPENING_EQUITY), with an as-of date not in the future. Opening stock (B5a) and vendor
balances (B6a) keep their own screens. Opening patient dues are deferred: they need an
invoice-like document so dues collection can allocate to them.

**D-110 Reports read the journal:** finance report, profit and loss and the daily summary are
SQL functions over business days (clinic time zone, `day_closing_hour`). Balances at the
start of a period are Σ before it, so a period always opens where the previous one closed.
Money in/out is grouped by the document that caused it; a reversal counts under the
document it reverses. The store P&L includes only entries tagged to that store.

**D-111 Books check (`verify_finance_integrity`):** what patients owe (Σ bills' outstanding),
stock value (Σ stock movements), cash and bank (every receipt, refund, purchase, vendor
payment and refund, expense, other income, opening) recomputed from the documents and
compared with the journal. Rs. 1 of rounding is allowed on stock value (bill lines round cost
to the paisa). Differences are logged and shown, never repaired. Runs nightly with the stock
and payables checks and on demand.

---

## B8b Reports (2026-11-21)

**D-112 Reports as built:** read-only SQL functions over business days: stock movement per
item (opening + received − sold net of returns − other out = closing, at lot cost), batch
history (every movement, running balance per store and overall), expiry (on hand, expired or
within N days), sales register (bills with returns, net paid, owed), item sales (void bills
excluded, returns subtracted; cost only for restocked returns), purchase register, cash book
(running cash balance). Access per report: stock and expiry `view_stock_reports` (store
scoped: someone without every store must pick one); sales and item sales `view_reports`;
purchases `manage_purchases` or `view_financial_reports`; cash book
`view_financial_reports`. Cost, value and margin columns appear only with
`view_cost_prices`. The vendor ledger stays the statement on each vendor's page (B6a).

**D-113 CSV export:** `/admin/reports/export`, the same report, permissions and store rules as
the page, needs an A3 session (`export`), is written to the audit log (`report.export`
with the filters and row count), UTF-8 with BOM for Excel, and defuses spreadsheet formulas
(a cell starting with = + - @ that isn't a number gets a leading ').

---

## B9a Realtime & notifications (2026-11-21)

**D-114 Realtime as built (owner choice, 2026-11-21): short SSE + an event table.** Triggers
write a topic-only row (`queue`, `bookings`, `dispensing`, `billing`, `stock`, or a person's
`notifications`), one per topic per transaction. `/api/realtime` streams new event ids for
the topics the person may see, checking every 2 s for ~50 s, then ends; the browser
reconnects at once with Last-Event-ID, so nothing is missed. Pages refresh through their own
permission-checked render; no data travels on the stream. Works on Vercel now; when
self-hosted the same contract can be fed by LISTEN/NOTIFY (D-09). Events are kept a day.

**D-115 Notifications and outbox as built:** in-app notifications per member (once per event
and kind), a bell with the unread count, push to each registered device, and an outbox with
one row per event, kind, channel and recipient, written in the same transaction as the event.
The dispatcher (`/api/cron/dispatch-notifications`) claims due rows with SKIP LOCKED,
retries with backoff (2, 8, 18, 32 min) and gives up after 5 tries; a row stuck in "sending"
for 10 minutes is claimed again (so a crash mid-send can repeat that one message once).
Cancelling an appointment cancels anything about it still waiting to go out, including an
unsent confirmation, so a patient never gets "confirmed" then "cancelled" out of order.

**D-116 What notifications say (PHI-minimal):** booking request → people with
`manage_appointments` ("New booking request", doctor and time, never the reason); prescription
issued → verified pharmacists (number and doctor only); patient emails → clinic, doctor, date
and time, clinic phone (confirmed, declined with the clinic's note only if the patient gave
it, cancelled, reminder). Never a reason for visit, diagnosis or medicine; push shows no
patient names (`push_shows_patient_name` is left for a later opt-in).

**D-117 Email and push delivery (owner choice, 2026-11-21):** email goes over Resend's HTTPS
API; until `RESEND_API_KEY` and `MAIL_FROM` are set, the dispatcher runs dry and marks emails
"skipped (no mail key, dry run)" so nothing is lost silently. Web push uses `web-push` 3.6.7
with VAPID keys generated into `.env.local` (the private key is server-only, checked absent
from client bundles); a device the push service reports gone (404/410) is switched off. Cron
routes accept `x-cron-secret` or Vercel Cron's `Authorization: Bearer` (lib/cron.ts).

---

## B9b Scheduled jobs (2026-11-21)

**D-118 Jobs as built:** appointment reminders are queued the moment an appointment is
confirmed, due `reminder_hours_before` ahead (tenant setting, default 24, 0 = off; skipped if
that moment is under 30 minutes away) and sent by the 5-minute dispatcher; cancelling the
appointment cancels them. `run_daily_jobs()`: subscription expiry → suspend; booking requests
not reviewed before their time are released (the requester is told if they gave an email);
confirmed appointments whose business day passed without a check-in → no-show; one stock
notice per clinic per day to `manage_stock` holders (counts only: expired, expiring soon,
low); a subscription-ending notice to admins within 7 days of the paid-until date (once per
date); sign-in housekeeping (PIN and password attempts after 90 days, expired session
records after a day; P-10 defaults until a retention policy is set).

**D-119 Schedules (owner choice: Vercel Cron, 2026-11-21):** `vercel.json` runs
`/api/cron/dispatch-notifications` every 5 minutes and `/api/cron/daily` at 18:30 UTC
(00:15 in Nepal), which runs the daily jobs and then the ledger, payables and books checks.
Every cron route accepts Vercel's `Authorization: Bearer CRON_SECRET` or `x-cron-secret`.
**Vercel's Hobby plan only allows once-a-day crons and rejects the deployment otherwise:**
on Hobby either upgrade, or set the dispatcher's schedule to daily and point an external
pinger at it every 5 minutes. Self-hosting can call the same routes from any scheduler.

---

## U3b Patients (2026-11-21)

**D-120 Patients screen as built; duplicates are resolved, not merged.** Admin → Patients:
search (name, phone, MRN), newest registrations, and a possible-duplicates list. A patient's
page shows details (editable by `manage_patients`: demographics only, the MRN never changes;
the audit records which fields changed, never the values), visits, appointments, bills and
what is owed (with Collect); no clinical content. A flagged patient shows the matching
records and why (same phone and first name, or same name and birth date); "they are different
people" clears the flag (`clear_duplicate_flag`, `manage_patients`, audited with the note).
Editing never re-flags. Combining two records of one person stays M-37 (P2: audited,
reversible); until then the desk keeps using the older record.

---

## U4 Registrar desk (2026-11-21)

**D-121 Printing at the desk:** the token and receipt print from their own narrow page per
visit (`/employee/registrar/receipt/[visit]`, 80 mm friendly), not the whole desk. An issued
prescription prints through `print_prescription` (`print_prescriptions`, A1): clinic,
patient, the medicines with dose and duration, the doctor's advice and their verified council
registration; never the complaint, diagnosis or notes. Every print (and every refusal) is
audited against the patient. The desk learns which visits have one through
`visit_prescriptions` (ids and numbers only).

**D-122 Rescheduling:** `reschedule_appointment` moves a confirmed appointment (optionally to
another doctor) in one transaction: the old one is cancelled as "Rescheduled to …", the new one
is booked through `book_appointment` (all slot rules) and points back via
`rescheduled_from_id`; a taken slot leaves everything as it was. The patient gets one "moved"
email (and the new reminder), never "cancelled" + "confirmed". The top-bar search goes to
Admin → Patients (or the desk, pre-filled, for desk staff without Admin); dues are collected
at the desk by `manage_billing` holders.

---

## U5 Doctor schedule (2026-11-21)

**D-123 A doctor's own leave:** My schedule (`/employee/schedule`, `manage_own_leave`) shows the
weekly OPD hours (set by the admin, read-only), the next 14 days' bookings, and the doctor's
leave: whole days over a range (up to 60 days) or part of one day, added and removed by the
doctor (`add_own_leave`, `remove_own_leave`, today or later). Leave rows are
`schedule_exceptions`, so free times disappear at once. Whoever adds leave (doctor or admin),
a trigger tells `manage_appointments` holders when it lands on bookings (counts and day only;
the doctor's note stays private). Bookings are never cancelled automatically: the desk sees
"Appointments to move: doctor on leave" (`appointments_on_leave`) and reschedules each.

**D-124 Follow-ups:** the OPD screen books a follow-up in the doctor's own diary
(`book_follow_up`, `write_consultation`) for a patient that doctor has seen, through
`book_appointment` (every slot rule), source `follow_up`; the patient gets the usual
confirmation and reminder. The date defaults to the consultation's follow-up date.

**D-125 Outbox × clinic status (found in U5):** the dispatcher claims messages of active or
pending clinics only; a suspended clinic's wait; a closed clinic's are cancelled ("clinic
closed"). Before this, a closed clinic's patients and staff could still be emailed and pushed.

---

## U6 Pharmacy workspace (2026-11-21)

**D-126 Barcodes are optional (owner direction, 2026-11-21).** A medicine needs no barcode
anywhere: it is found by name, generic or code at the counter, in stock, transfers, counts
and reports. The medicine form labels Barcodes "(optional)". Where barcodes exist, the counter
accepts a keyboard-wedge scan: an exact code + Enter adds one of that unit (or one more on
the same line); a blocked or controlled item is refused; Enter with a single typed match adds
it too.

**D-127 Stock in the Pharmacy workspace:** a Stock tab (`view_stock`) for staff who work at a
PIN (A1) and may not have Admin: on hand per batch in each store they're assigned to (packs
shown as box + strip + tab, expired and blocked marked), search, transfers in and out (request
and send/receive per their access), and stock counts (start and count at A1; posting needs a
password and `manage_stock`). Adjustments, disposal and posting stay in Admin → Stock (A2).

---

## Vercel deployment fix (2026-11-21)

**D-128 Vercel Hobby: both crons once a day.** The every-5-minutes dispatcher schedule (D-119)
made every Vercel deployment from 668a705 on fail (Hobby allows only once-a-day crons, and a
more frequent one rejects the whole deployment; the last good deploy was 4c0c77a, before
vercel.json existed). vercel.json now runs `/api/cron/daily` at 18:30 UTC and
`/api/cron/dispatch-notifications` at 18:45 UTC (00:15 and 00:30 in Nepal). Effect: queued
emails and pushes go out once a night until either the project moves to Vercel Pro (then set
the dispatcher back to `*/5 * * * *`) or an external pinger calls the dispatcher every 5
minutes with `x-cron-secret` (no deployment change needed). In-app notifications and live
updates are unaffected: they never wait for a cron.

---

## U8a Install, offline, idle lock (2026-11-21)

**D-129 Installable, never cached:** a web app manifest (standalone, opens /employee, icons
192/512/maskable drawn in code at /pwa-icon/*, pre-rendered at build) and iPhone home-screen
metadata (apple-touch-icon 180). The service worker (registered for everyone) caches exactly
one page, /offline, and serves it only when a page load fails; no patient, bill or stock page
is ever stored on a device. A banner shows while the device is offline.

**D-130 Idle lock as built:** after the clinic's `idle_lock_minutes` with no activity in any
tab (default 10; at least 15 on a device that isn't trusted), the screen blurs with a
60-second "Still there?" countdown; any touch or key continues, otherwise the session signs
out on that device (local scope) and the next person signs in (PIN on a trusted device). A
blur alone would only hide; signing out is the lock. The purchase bill prints as a goods
received note.

---

## U2 Platform settings, contact, audit, health (2026-11-21)

**D-131 Platform settings and Contact:** one `platform_settings` row (support phone, WhatsApp,
email, hours, office address; registrations open/closed), changed only by a platform admin
through `set_platform_settings`, audited with before and after. The public /contact page shows
those details (no message form: no spam inbox). While registrations are closed the form is
hidden and `submitRegistration` refuses (a marketing switch, enforced in the app; the
database keeps its own limits). Pricing on the landing page was already live from public
plans.

**D-132 Super Admin oversight:** Platform audit (platform admins' actions and the platform
jobs; per clinic, everything) never identifies patients ("a patient record"). The overview's
Health panel (`platform_health()`): last nightly check, clinics whose books or vendor
payables differ, stock balances repaired, messages waiting/failed/dry-run, errors and refusals
in 24 h, subscriptions ending within 14 days; the environment label comes from APP_ENV. Plans
& billing lists every invoice to clinics with what is outstanding.

**Lesson (U2):** Supabase's API refuses an UPDATE without a WHERE clause (safeupdate), which
direct-connection DB tests don't see. Single-row updates name their row (`where id`), and every
new write path is exercised end to end through the app, not only in DB tests.

---

## U7 Manage link in patient emails (2026-11-21)

**D-133 Every confirmation, reminder and "moved" email carries a private "see or cancel" link.**
Tokens are only ever stored as an HMAC keyed by the app, so the database cannot rebuild a link:
the dispatcher mints a fresh 32-byte token per email at send time, records its hash
(`add_manage_link` → `appointment_links`) and puts the URL (NEXT_PUBLIC_APP_URL) in the text
and as a button. The website's original link keeps working; status and cancel accept either
(`appointment_by_token`, scoped to the clinic's address). No link is minted in dry-run mode
(nothing is sent). Declined/cancelled emails carry no link. `RESEND_API_BASE` (normally
unset) lets a relay or a local test stub stand in for Resend.

**D-134 The optional patient account is deferred to after the pilot.** The emailed link gives
every patient (website or desk booking) a way to see and cancel without an account.

---

## Browser UI pass (2026-11-21)

**D-135 Fixes from driving the app in a real browser (headless Chrome via playwright-core,
outside the repo):** (1) the idle lock was rendered inside the top bar, whose backdrop blur made
"fixed inset-0" cover only the bar, leaving patient screens readable; it now renders on
<body> (portal) and is checked to cover and blur the whole window. (2) On phones, Admin →
Billing scrolled sideways by 511 px and the registrar queue by 5 px: grid columns without an
explicit size grew to their widest content; all 21 page grids now use `grid-cols-1` below
their breakpoint, and the queue's status links wrap. (3) "Dr. Dr. Name" when the display name
already starts with "Dr.": `dr_name()` in SQL (notification triggers) and `drName()` in the app
add the title only when missing.

**Testing note:** the long-running `next dev` server goes stale after many edits (actions
fail, pages reload in loops). Final checks run against a fresh production build
(`next build` + `next start -p 3100`); restart `next dev` before manual testing.

**D-136 SMS dropped from Phase 2 (owner, 2026-11-21):** M-32 (SMS reminders and SMS OTP)
moves to Future and may never be built. Patient messages stay email (dry run until a mail key
is set) plus in-app and web push. P-05 (SMS provider) is parked, not pending.

**D-137 Controlled-drug register (M-48) and cashier shifts (M-47) dropped from Phase 2 (owner,
2026-11-21):** both move to Future. Consequence kept on purpose: items marked controlled or
narcotic stay **blocked from sale** in the system (P-22 unchanged); clinics sell those outside it
until M-48 is built. Cash is reconciled per day (daily summary, cash book), not per shift.

---

## M-37 Patient merge (2026-11-25, Phase 2)

**D-138 Two records of one person are combined by moving rows, recorded so it can be undone.**
`merge_patients(tenant, kept, merged, by, reason)` (migration 0057, `manage_patients`) moves
every row of the merged record to the kept one: appointments, visits, invoices, payments,
sale returns, allergies, vitals, encounters, prescriptions, outside prescriptions and care
grants. Each moved row is listed in `patient_merge_rows` (with the appointment's status at
the time). The merged record gets `merged_into` + `deleted_at`, so every list, search, booking
and check-in already treats it as gone; `search_patients` still finds the kept record by
the merged record's MRN (old cards keep working). Locked rows (signed consultations, issued
prescriptions, vitals) may change only their patient, and only between the two records of a
merge in either direction (`patient_merge_move_ok`, data-based, no session flag); any other
change is still refused. **Not moved:** `ledger_entries` (append-only journal; its patient
column is never read by patient: dues come from invoices) and `audit_log` (history stays as it
happened). Refused while the merged record is in today's queue (`MERGE_LIVE_VISIT`: a doctor
may have its chart open) or when both have overlapping live bookings
(`MERGE_APPOINTMENT_CLASH`). The kept record's demographics are not touched; staff copy
missing details first. The kept record's duplicate flag clears once no other likely match is
left. **Undo** (`undo_patient_merge`) moves exactly the listed rows back and unhides the record.
Rows created on the kept record since then stay there, and so does an appointment whose
status changed since the merge, so it stays with the visit it made. Undo is refused if the
kept record was itself merged later (undo that first). A payment collected after the merge
can end up allocated to a bill that moves back; allocations are by bill, so the books stay
right. Both steps are audited against the kept patient. Screen: Admin → Patients → a patient:
"Same person: combine" on each likely match, "Combine with another record" (by MRN, choose
which to keep, a confirmation tick), "Combined records" with Undo; the merged record's page
says where everything went.

---

## M-52 Patient advances (2026-11-25, Phase 2)

**D-139 A patient advance is money held for the patient (a liability) and is spent as a third
payment leg.** Migration 0058. A deposit or refund is a `patient_advances` row (append-only,
`AD-` receipt per billing profile, cash/online legs): Dr CASH/BANK / Cr PATIENT_ADVANCES, or the
reverse for a refund. Using it is an ordinary payment whose `advance_amount` leg funds it
(cash + online + advance = amount), so dues, bill pages, voids and returns work as before:
Dr PATIENT_ADVANCES / Cr AR_PATIENTS. Held = deposits − refunds − advance legs
(`patient_advance_balance`); it can't go below zero (an advisory lock per patient,
`patient_advance_locked`, so two bills can't spend one deposit).
- **Automatic use:** `check_in_visit` and `issue_counter_sale` take the unpaid part of a new bill
  from the advance before the credit rules apply, so a clinic that allows no dues can still
  bill against a deposit. The desk and counter forms show "From the advance" and ask only for
  the rest. Both functions are the 0023/0044 bodies with only those lines changed (made by
  checked text substitution, so nothing else drifted).
- **Older bills:** `use_patient_advance` pays open bills oldest first (one payment per billing
  profile). A deposit made after a credit bill doesn't pay it by itself; staff press "Pay …
  from the advance".
- **Who:** taking and using need `manage_billing` or `pharmacy_sell`. Giving back needs
  `manage_billing` and a reason, can't exceed what is held, and doesn't ask for re-auth (the
  amount is capped by the deposit; it is audited). Both are in the posture allow-list.
- **Void:** each payment is refunded in its legs, and an advance leg goes back to the advance
  (Cr PATIENT_ADVANCES), never out as cash. Rounding goes to the advance leg if there is one.
  A sale return still refunds in cash/online or reduces the due.
- **Reports:** the finance report shows "Advances held for patients". Money in/out has
  "Patient advances". The day's "Collected" is now cash + online only (money really
  received), with advances taken, used and given back listed separately. The nightly books
  check adds the deposits to cash/bank and an `advances` line (documents vs the
  PATIENT_ADVANCES balance).
- **Merge (D-138):** advances move with the patient. Undo is refused
  (`MERGE_UNDO_ADVANCE_SPENT`) while the kept record has spent the merged record's deposit;
  void those bills first.
- **Not done:** returning sale-return money into the advance; advances on the Billing list.

---

## M-51 Bulk recall (2026-11-25, Phase 2)

**D-140 A recall covers one medicine and one batch number, in every store, in one step.**
Migration 0059. Lots are per receipt, so the same printed batch can be several lots (other
purchases, other stores). `recall_batch(item, batch_no, reason, reference)` needs a password
session (A2) and `block_batches`, the same as blocking one lot. It records a `batch_recalls`
row and each lot covered (`batch_recall_lots`, with its status before) and marks every lot
`recalled` with history and audit. Lots already recalled are listed but not changed again.
Batch numbers are matched upper-case without spaces. Another medicine's identical batch
number is untouched (a notice names the product). An unknown batch number is refused rather
than recorded. Allocation already refused recalled lots; a lot chosen by hand is refused too
(`LOT_NOT_SELLABLE`). Holders of `block_batches` are notified with a link to the recall page,
and holders of `pharmacy_sell` with a link to the pharmacy stock tab. **Who bought it:**
`recall_affected_sales` lists issued bills with a recalled lot, quantity sold and returned,
and the patient (name, MRN, phone) or walk-in name and phone. It needs `block_batches` and
every read is audited (`batch.recall_sales_read`), because it is a contact list. There is no
"undo recall": a lot recalled by mistake is unblocked one by one from the stock page
(audited). Stock left is moved to quarantine with the existing lot action; contacting
patients is by phone (no SMS, D-136).

---

## Pending decisions

| ID | Question | Alternatives | Recommended default | Blocking? |
|---|---|---|---|---|
| **P-01** | Platform domain & URL scheme | `.com` / `.com.np`; path vs subdomain for clinics | buy the domain now; path `/c/[slug]` in MVP (D-13) | Phase 0 start |
| **P-02** | Hosting location | dedicated VPS / same VPS as HRestroSewa / Nepal DC / hosted cloud | dedicated VPS (`deployment.md` §3, option A) unless P-09 requires Nepal | pilot gate (prod readiness) |
| **P-03** | Scheduling mode | time slots / daily tokens / both per doctor | **both**, configurable per doctor schedule | B3 |
| **P-04** | Guest booking verification | none / SMS OTP / manual confirmation | CAPTCHA + rate limits + per-phone caps + optional manual confirmation in MVP; OTP once P-05 done | no |
| **P-05** | SMS / messaging provider | Nepali SMS aggregators (e.g. Sparrow SMS, Aakash SMS: verify availability/pricing), Viber/WhatsApp business | evaluate cost, DLR reliability, sender-ID rules; decide before P2 | P2 |
| ~~P-06~~ | Shared reception device sign-in | **Resolved by D-27** (2026-11-20): trusted devices + PIN quick access + switch user + idle lock, in the MVP | — | — |
| **P-07** | Admin clinical access & doctor history window | strict (D-06) / clinic setting "admin clinical read (audited)" / limit C2 to N months | strict + C2 unlimited (audited) | B4 |
| **P-08** | Tax & IRD billing compliance; Rx format rules | see `security.md` §10 | keep `tax_category`, `fiscal_year` fields; get counsel opinion | before go-live |
| **P-09** | Data residency | foreign VPS / Nepal hosting | depends on counsel reading of privacy & cyber policy | before go-live |
| **P-10** | Retention & deletion periods; consent text | — | soft delete only; placeholder 10 years; counsel to set | before go-live |
| ~~P-11~~ | MFA scope | **Resolved (owner, recommended default):** mandatory for platform admins, tenant admins and doctors; optional for others (`mfaRequired()`) | — | — |
| **P-12** | Online payments (subscriptions & patients) | manual recording / eSewa / Khalti / Fonepay | manual in MVP; gateway in P2 | P2 |
| **P-13** | Language | English only / bilingual from MVP | i18n-ready MVP, English UI; Nepali public site P2 | no |
| **P-14** | Plans & pricing | per clinic / per doctor / tiered features | per-clinic tiers with doctor caps (schema supports either) | before go-live |
| **P-15** | Diagnosis coding | free text / ICD-10 / ICD-11 | free text + optional ICD-10 field | no |
| **P-16** | Multi-tenant membership in MVP UI | hidden / tenant switcher | hidden in MVP (model supports it, D-24) | no |
| ~~P-17~~ | Pilot go-live point | **Resolved by D-58**: one pilot gate at the end of Phase 1 (clinic + pharmacy) | — | — |
| ~~P-18~~ | Employees without personal email | **Resolved (owner, recommended default):** usernames allowed for staff (clinic link required); email required for tenant admins (DB CHECK) | — | — |
| ~~P-19~~ | PIN length | **Resolved (owner, recommended default):** 6 digits; repeated digits and sequences refused | — | — |
| **P-20** | Patient account sign-in method | email OTP / SMS OTP / password | email OTP in MVP; SMS OTP with P-05; no patient passwords | B4 |
| ~~P-21~~ | Business types at launch | **Resolved by D-58**: `clinic_pharmacy` at launch; clinic-only and pharmacy-only later | — | — |
| **P-22** | Drug classes & dispensing rules | — | model `schedule_class`; enforce Rx-required for prescription-only and controlled items; counsel/DDA to confirm categories, narcotics register and pharmacist requirements | B7 |
| **P-24** | Platform drug master | none (each tenant types its own) / platform-seeded generics, dosage forms, strength units / full product master | seed generics + dosage forms + units at platform level; items stay tenant-owned | B5 |
| **P-25** | Sale price above MRP | allow / refuse / allow with reason | refuse (`PRICE_ABOVE_MRP`); verify the legal MRP rule | B7 |
| **P-26** | Finance engine | double-entry journal + reconciliation (D-43) / pure derivation from documents (HRestroSewa) | journal | **B0** (posting core in foundation) |
| **P-27** | Tax on medicines and services | all exempt / VAT on some items / per-item tax category | per-item and per-service `tax_category`; counsel to confirm (with P-08) | before go-live |
| **P-28** | Restocking customer returns | allow sealed packs / quarantine only / never | sealed, unexpired, non-cold-chain → sellable; else quarantine (pharmacist confirms) | B7 |
| ~~P-23~~ | Session minting after PIN | **Resolved by D-67:** generateLink + verifyOtp, proven by spike | — | — |
| ~~P-29~~ | Billing entities | **Resolved by D-58**: same PAN, one billing profile (multi-profile capability kept) | — | — |
| ~~P-30~~ | Credential verifier in single-admin tenants | **Resolved (owner, recommended default):** another tenant admin, or a platform admin; never the holder (`verify_member_credential`) | — | — |
| ~~P-31~~ | Consultation-fee billing point | **Resolved by D-58**: at registration (check-in), by the registrar | — | — |
| **P-32** | Super Admin IP allow-list | none / allow-list / VPN only | allow-list once ops IPs are stable; TOTP mandatory regardless | B2 |
