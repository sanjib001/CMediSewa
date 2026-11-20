# Permissions

Status: **Recommendation** (Revision 2). The structure is adapted from HRestroSewa's
`lib/permissions.ts` (single source of truth, sections → levels → extras, presets, navigation
derived from permissions, server re-checks everywhere). The medical additions are
**configurable roles**, **professional credentials gating clinical keys**, **session
assurance levels**, the **care relationship**, **break-glass**, and the rule that the
**Admin does not bypass clinical content**.

## 1. Four questions, four mechanisms
Every request that touches data is checked on four independent axes:
1. **Which tenant?** Resolved from the live `tenant_members` row. Never taken from the
   client.
2. **May this person do this kind of thing?** Capability: the effective permissions from
   their roles.
3. **Is this session strong enough for it?** Assurance: A1 / A2 / A3 (§2, §3).
4. **May they do it to this patient?** Record level: the care relationship (§6), checked in
   SQL inside the clinical RPCs.

Passing one check never widens another. HRestroSewa applies the same rule with
`close_bills`, which never widens which tables you see.

## 2. Session assurance levels
| Level | How obtained | Typical use |
|---|---|---|
| **A1: PIN** | PIN on a **trusted device** of this tenant (or a PIN unlock after the shift window lapsed) | front-desk and counter operations |
| **A2: Password** | email + password, or a PIN unlock within the shift window (default 12h) of a password sign-in **on the same device** | clinical work, admin back-office |
| **A3: Password + MFA** | A2 + TOTP (`aal2`) | Super Admin always; sensitive admin operations (§3); doctors/admins if P-11 mandates |
| **Recent re-auth** | password (and TOTP if enrolled) re-entered within the last 5 min | destructive or money-moving corrections, permission changes, exports, break-glass |
A step-up upgrades the current session in place (`architecture.md` §6).

## 3. Operation × minimum assurance matrix
This defines which operations PIN access may perform. Each operation still needs its
capability permission.

| Operation | Min. level | Notes |
|---|---|---|
| View today's appointments, queue, own schedule, notifications | A1 | |
| Book, reschedule or cancel appointments; register a patient; edit demographics | A1 | demographics are personal data, so they are audited at the patient-profile level |
| Check-in, token, call next, checkout | A1 | |
| Record vitals for a patient checked in today (care rule C3) | A1 | write-only plus today's vitals. No history view |
| Pharmacy counter: OTC sale; dispensing an **issued** Rx (sees Rx items only); recording an external Rx | A1 | Rx-required enforced in SQL; controlled/narcotic blocked until M-48 (P-22) |
| Choosing a non-FEFO lot (`override_batch`) | A1 | the override is recorded on the allocation; expired or blocked lots can never be chosen |
| Cashier: create/issue invoice, take payment (cash/online/mixed), collect dues, print receipt | A1 | discounts only within the role's limit |
| Stock (assigned stores only): draft a purchase invoice/receipt, transfer request, dispatch, receive, count entry, move to quarantine | A1 | |
| Approve a transfer (`approve_transfers`) | A1 (A2 if the transfer value exceeds the tenant threshold) | |
| Record an expense (`add_expenses`) | A1 | today only, no back-dating |
| Print an issued prescription (`print_prescriptions`) | A1 | audited |
| **Open a patient's clinical chart / history; write a consultation; issue a prescription** | **A2** | PIN alone never opens a medical record (D-27). A3 if P-11 requires it for doctors |
| Enter or view lab results (P2) | A2 | |
| Any page in the **Admin** area | A2 | |
| **Post** a purchase invoice, PO, purchase return, vendor payment, stock adjustment, count, disposal; block/recall a lot; item master and unit changes; sale price changes (`set_prices`) | A2 | |
| Sale return posting; refunds; due/credit above the patient's limit; discounts above the role limit | A2 + recent re-auth | |
| Void a sales invoice (same day) or a purchase invoice (untouched lots only); reverse a vendor payment or expense; opening stock and opening balances | A2 + recent re-auth | |
| View cost prices, margins and finance (`view_cost_prices`, `view_finance`) | A2 | the counter UI hides cost by default |
| Employees, roles, permissions, PIN reset for others, trusted-device enrolment/revocation | A3 (or A2 + recent re-auth if MFA isn't enrolled and P-11 allows) | |
| Tenant settings, website publish, invoice numbering, finance opening balance | A2 + recent re-auth | |
| Exports (patients, clinical, finance) | A3 | audited and watermarked |
| Break-glass emergency access | A2 + recent re-auth + reason | §7 |
| Super Admin anything | A3 | never PIN |
The single source for this matrix is `lib/permissions.ts` → `OPERATION_ASSURANCE`. Guards
read it, and so do the UI (to show step-up prompts) and the tests.

## 4. Roles: configurable, not hardcoded (D-30)
- **Membership role (fixed):** `tenant_admin` | `tenant_member`. A `tenant_admin` holds
  every **operational** permission implicitly (HRestroSewa's `restaurant_admin` bypass), but
  **not the clinical keys** (D-06).
- **Tenant roles (configurable):** `tenant_roles(name, permissions[], home_route,
  is_system_template)`. Each new tenant is seeded with **templates** it can rename, edit,
  clone or delete: Doctor, Receptionist, Nurse, Pharmacist, Inventory Manager, Cashier, Lab
  Technician, Accountant. A tenant can create any other role ("Front-desk supervisor",
  "Store keeper").
- **Assignment:** a member can hold **one or more roles**. Effective permissions are the
  union of the role permissions plus `member_permission_overrides` (grant/revoke individual
  keys, shown as "Custom", HRestroSewa-style). The editor shows one control per section
  (None / View / Full + extras).
- **Professional credentials gate clinical keys.** `member_credentials(profession, council,
  registration_no, verified_by, verified_at)` with professions `doctor`, `nurse`,
  `pharmacist`, `lab_technician` (to verify the matching Nepali councils: NMC, Nepal Nursing
  Council, Nepal Pharmacy Council, Nepal Health Professional Council). A clinical key is
  **effective only if the member holds a matching credential**:
  | Key | Required profession |
  |---|---|
  | `write_consultation`, `issue_prescriptions` | doctor |
  | `view_clinical` | doctor, nurse, lab_technician |
  | `record_vitals` | doctor, nurse |
  | `dispense_prescription`, `sell_prescription_only` | pharmacist (P-22) |
  | `enter_lab_results` (P2) | lab_technician, doctor |
  A role holding such a key gives nothing to a member without the credential. The editor
  shows the key as "inactive: needs credential". The rule is enforced in the effective-
  permission function in SQL and TS (the same idea as HRestroSewa's business-type gating:
  not grantable means not effective).

## 5. Permission keys (proposed; write implies read within a section)
| Section | Keys | Business type |
|---|---|---|
| Front desk | `view_patients`, `manage_patients`, `view_appointments`, `manage_appointments`, `view_queue`, `manage_queue` | clinic |
| Schedules | `view_schedules`, `manage_schedules` (+ extra `manage_own_leave`) | clinic |
| Clinical | `record_vitals`, `view_clinical`, `write_consultation`, `issue_prescriptions` (+ extras `print_prescriptions`, `view_all_clinical`, `break_glass`) | clinic |
| Pharmacy counter | `pharmacy_sell`, `dispense_prescription`, `sell_prescription_only` (+ extra `override_batch`) | has pharmacy |
| Inventory (store-scoped, §5a) | `view_stock`, `receive_stock`, `transfer_stock`, `approve_transfers`, `manage_stock` (adjustments, count posting), `dispose_stock`, `block_batches` | has pharmacy, or clinic stores |
| Item master | `manage_items` (catalogue, units, barcodes, levels), `set_prices` (lot sale prices) | as inventory |
| Purchasing | `manage_purchases` (PO, purchase invoices), `return_to_vendor`, `manage_vendors` (vendor CRUD), `pay_vendors` (payments) | as inventory |
| Billing | `view_billing`, `manage_billing` (+ extras `apply_discounts`, `void_invoices`, `sale_returns`, `issue_refunds`, `allow_credit`) | all |
| Expenses & finance | `add_expenses`, `manage_expenses`, `view_finance`, `view_cost_prices` | all |
| Reports | `view_reports`, `view_financial_reports`, `view_stock_reports` (store-scoped) | all |
| Store scope | `all_stores` (see every store without assignment) | as inventory |
| Website | `manage_website` | all |
| Administration | `manage_staff` (employees, roles, PINs, devices), `manage_settings`, `manage_catalogue` (departments, services, doctors' public profiles), `view_audit_log` | all |
| Lab (Phase 3) | `view_lab`, `manage_lab_orders`, `enter_lab_results` | plan feature |
The HRestroSewa split between `manage_purchases` and `manage_vendors` is kept and taken
further: recording a supplier bill, editing the vendor list and **paying** a vendor are
three trust levels (`pay_vendors` is new, because it moves money).

### 5a. Store-scoped permissions (Revision 3)
- **Yes, each store has its own inventory permissions.** A stock key is **effective only in
  stores the member is assigned to** through `store_members` (access `view` | `operate` |
  `manage`). This is HRestroSewa's strict assignment rule, where a manager assigned to one
  floor sees only that floor.
  | Store access | Keys that work there |
  |---|---|
  | `view` | `view_stock`, `view_stock_reports` |
  | `operate` | + `receive_stock`, `transfer_stock`, `pharmacy_sell`, `dispense_prescription`, count entry |
  | `manage` | + `approve_transfers`, `manage_stock`, `dispose_stock`, `manage_purchases` for that receiving store |
  The effective key = role key ∧ store access ≥ the required level ∧ business type ∧
  assurance.
- `tenant_admin` and holders of `all_stores` act in every store.
- **Transfers need both ends:** request in the destination, approve and dispatch in the
  source, receive in the destination. One person can do all of it only if assigned to both
  stores.
- **Selling:** an invoice's item lines allocate only from the invoice's store, which must be
  one where the cashier has `operate` access and that `is_sellable`.
- Item master, prices, vendors and finance are **tenant-wide** keys (not store-scoped).
- Store-level reports show only assigned stores. The tenant-wide P&L needs
  `view_financial_reports` + `all_stores`.

### 5b. Segregation of duties (settings, default off for tiny tenants)
- `count_post_requires_other_member`: the person who counts can't post that count.
- Transfer approval by someone other than the requester.
- A posted purchase can't be voided by the person who posted it, when another
  `manage_purchases` member exists.
- A refund above a threshold needs a second member's approval (P2). **Administration keys are
delegable** (unlike HRestroSewa, where staff CRUD is Super Admin authority), because the user
requirement is that the tenant admin manages employees. They need A3 or recent re-auth (§3).
**Never add a key that gates nothing** (HRestroSewa rule).

## 6. Record-level access: the care relationship
`can_access_clinical(member, patient, purpose)` is one predicate in TS and SQL, shared by
pages, actions, RPCs, push recipients and exports. It returns true if **any** of these holds:

| # | Rule | Scope |
|---|---|---|
| C1 | Member is the **doctor** on today's or an upcoming non-cancelled appointment/visit for P | full chart read + write for that encounter |
| C2 | Member is the doctor of **any past encounter** with P | chart read. Write only to their own encounters/addenda (P-07: time limit?) |
| C3 | P has an **open visit today** and the member holds `record_vitals` | vitals, allergies, current-visit summary only |
| C4 | An explicit **grant** (referral/share) in `care_access_grants`, not expired | as granted |
| C5 | Member holds `view_all_clinical` | full read. Every read audited |
| C6 | An open **break-glass** grant for (member, P) | full read for 60 min |
| C7 | Pharmacist dispensing an **issued** Rx for P | that Rx's items and the allergy list only |
**Clinical** = encounters, vitals, diagnoses, notes, addenda, Rx content, allergies,
conditions, lab results, clinical files. **Not clinical** = demographics, appointment times,
visit/token, invoices, and stock movements (even though an invoice line can imply a
condition, `view_billing` is treated as trusted: **Assumption**). The patient's free-text
booking reason is visible to front desk and doctors, and never sent on external channels.

## 7. Break-glass
Holders of `break_glass` only (granted to nobody by default). The member gives a reason
(required) and re-authenticates. The RPC creates a 60-minute grant, writes `audit_log`, and
notifies every tenant admin in the app. The admin audit view lists break-glass events that
haven't been reviewed yet.

## 8. Area access summary
| Area | Who | Assurance |
|---|---|---|
| Marketing | anyone | none |
| Client/Patient site | guests; patient accounts (OTP) for "my appointments"; **verified** link for clinical documents | patient session (separate from staff) |
| Employee | any active member | A1+; per operation (§3) |
| Admin | `tenant_admin`, or a member holding any Administration/back-office key for that page | A2+ |
| Super Admin | `platform_admins` | A3 |

## 9. Default role templates (seeded; editable per tenant; Revision 5, D-56/D-57)
**Seeded and shown first** (they match the clinic's real staffing):
| Template | Main keys | Store access | Home (dashboard) |
|---|---|---|---|
| **Registrar** | view/manage_patients, view/manage_appointments, view_schedules, view/manage_queue, **view/manage_billing (OPD fee and services bills, receipts, dues collection)**, print_prescriptions, add_expenses (optional) | — | `/employee/registrar` |
| **Doctor** (requires a doctor credential) | view_patients, view_schedules, manage_own_leave, view_queue, record_vitals, view_clinical, write_consultation, issue_prescriptions, print_prescriptions | — | `/employee/opd` |
| **Pharmacy** (pharmacist + cashier + stock, D-57; dispensing keys require a pharmacist credential, P-22) | pharmacy_sell, dispense_prescription, sell_prescription_only, override_batch, view/manage_billing, sale_returns, allow_credit (optional); view_stock, receive_stock, transfer_stock, approve_transfers, manage_stock, dispose_stock, block_batches, manage_items, set_prices; manage_purchases, return_to_vendor, manage_vendors, pay_vendors (admin may remove); view_cost_prices, view_stock_reports | Pharmacy = manage (+ any other store the admin assigns) | `/employee/pharmacy` |
| **Lab Technician** (Phase 3) | view_patients, view_queue, view_lab, enter_lab_results | Lab store (Phase 3) | `/employee/lab` |

**Optional templates** (offered when adding staff, not seeded as defaults):
| Template | Main keys | Home |
|---|---|---|
| Nurse / health assistant | view_patients, view_queue, manage_queue, record_vitals, view_clinical (C3 scope) | `/employee/registrar` (queue view) |
| Cashier (only if billing is split from pharmacy) | view/manage_billing, pharmacy_sell | `/employee/pharmacy` (counter view) |
| Accountant | view_billing, add/manage_expenses, view_finance, view_financial_reports, view_cost_prices, pay_vendors, all_stores (view) | `/admin/finance` |
| Store keeper (only with a separate main store) | view/receive/transfer stock, manage_stock | `/employee/pharmacy` (stock view) |
**Other staff** get custom roles built from these keys. A workspace shows only the panels
the member's keys allow. Assurance rules (§3) apply to every template: the Pharmacy person's
counter work runs on a PIN (A1), but posting purchases, vendor payments, adjustments and
returns asks for the password (A2, plus re-auth where listed).

## 10. Admin and Super Admin, explicitly
- **Tenant Admin:** all operational keys, all of the Admin area, the audit log and the
  website. **No implicit clinical access.** An owner-doctor gets clinical access through a
  doctor credential + role. Others use break-glass. The alternative (a tenant setting for
  audited admin clinical read) is pending as P-07. The admin may use PIN quick access only
  for A1 work. Entering the Admin area steps the session up to A2.
- **Super Admin:** tenants, applications, plans, platform billing, monitoring (aggregate
  counts only), settings and support. **No route, action or RPC exposes patient rows,
  clinical data, stock or financial detail of a tenant** (D-08). Super Admins can suspend a
  tenant and reset its admin's access (audited).

## 11. Inheritance & exceptions
- Write implies read. Admin implies all operational keys, never clinical keys.
- A doctor sees their own appointments and schedule without the clinic-wide keys.
- A clinical key without a matching credential is inert. A module the business type lacks
  is neither grantable nor effective.
- The assurance requirement is independent of permissions. Holding a key at A1 still means
  a step-up is needed for A2 operations.
- A deactivated member, revoked device, or suspended tenant has no access, checked live.
- PIN quick access is per member and can be turned off by the tenant (`tenant_settings.pin_policy`:
  off / allowed / required on trusted devices).
- Navigation is derived from permissions, business type and assurance (items needing a
  step-up show a lock icon). Client gating is convenience only, and every page and action
  re-checks.

## 12. Access verification matrix (Revision 4 audit)
| Requirement | Mechanism | Where enforced | Test |
|---|---|---|---|
| Super Admin access is platform-level only | `platform_admins` separate from `tenant_members`; platform actions in `app/actions/platform/*`; no tenant-data RPC accepts a platform actor | guards + RPC actor checks | negative suite: every tenant RPC called as a platform admin → denied |
| Each tenant's data is independent | `tenant_id` + composite FKs everywhere; tenant from the live membership only | DB + `resolve_request_context` | two-tenant isolation suite on every action/RPC |
| Admin restricted to their own tenant | membership role per tenant; no cross-tenant parameter accepted | guards | the suite above, as admin |
| Employees follow permissions | effective permissions (roles ∪ overrides ∩ business type ∩ modules ∩ credentials) + assurance level | TS guard + SQL `effective_permissions` (parity test) | preset × route/action matrix |
| Store-level inventory access | `store_members` access level, checked inside posting RPCs | SQL | per-store negative tests |
| Doctor access to records | care relationship C1–C7, chart reads audited, A2 minimum | clinical RPCs | care matrix tests; denied reads audited |
| Admin can't self-grant clinical access | credential verified by **another** person (D-52); every credential change notifies all admins; break-glass audited | `verify_credential` RPC refuses `verifier = holder` | test: self-verification refused |
| Patients see only their own information | guest: manage-token-scoped single appointment; account: own bookings + **verified** links only | public RPCs | public-contract + cross-account tests |
| Public sites can't expose other tenants | tenant resolved from slug, and every `public/*` query is filtered by that `tenant_id`; tenant-tagged cache keys; allow-listed output types | `app/actions/public/*` | test: slug A never returns B rows; cache key includes tenant |
| Disabled modules are inert | module registry check in guards and RPCs (`MODULE_DISABLED`) | TS + SQL | module-off tests |
| PIN never reaches records or money corrections | A1 ceiling in `OPERATION_ASSURANCE` | guards + RPC `p_session_level` check | assurance matrix tests |
**Residual trust assumptions (documented, not eliminated):** a tenant admin can reset a
username-account's password (an admin one-time code) and so could impersonate that employee.
It is audited, and the employee is notified on their next sign-in. A tenant admin with
`manage_staff` can grant operational permissions to anyone. Anyone holding the server's
service-role key can bypass everything, so it is kept server-only, rotated, and never on
laptops.
