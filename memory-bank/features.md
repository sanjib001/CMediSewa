# Features

The module inventory (Revision 2: module IDs renumbered for the five-area structure).
Phasing (Revision 5, owner-directed, D-55): **MVP** = backend in **Phase 0**, UI in
**Phase 1** · **P2** = Phase 2 · **P3 / Phase 3** = laboratory · **F** = future. BT =
business type (`clinic_pharmacy` at launch, D-58; `clinic` and `pharmacy` later).
Labels such as "MVP (services)" or "MVP (item lines)" describe scope only. Both are part of
the same MVP.

## 1. Module catalogue

### Platform (Marketing + Super Admin)
| ID | Module | Phase | Purpose | Depends on | Roles | Main data |
|---|---|---|---|---|---|---|
| M-01 | Marketing website | MVP | Landing, features, pricing (from public plans), contact/support info, legal pages, SEO | M-04 | prospects | plans (read) |
| M-02 | Business registration & onboarding | MVP | Registration form → email verification → application → Super Admin review → tenant provisioning + admin invite | M-03, M-07 | prospect, Super Admin | tenant_applications, tenants |
| M-03 | Tenant management | MVP | Create/approve, activate, suspend, close tenants; reset admin access; business type | M-07 | Super Admin | tenants |
| M-04 | Plans, subscriptions & platform billing | MVP (manual payments) | Plan CRUD, subscription periods, platform invoices to tenants, payment recording, expiry → suspension cron | M-03 | Super Admin | plans, tenant_subscriptions, platform_invoices, platform_payments |
| M-05 | Platform monitoring, analytics & settings | MVP-lite | Tenant activity (last active, counts), growth, delivery failures; platform settings, feature flags | M-03 | Super Admin | derived; platform_settings |
| M-06 | Support desk | P2 | Tenant ↔ platform tickets; onboarding checklist tracking | M-03 | Super Admin, tenant admin | support_tickets |

### Identity & access
| ID | Module | Phase | Purpose | Depends on | Roles | Main data |
|---|---|---|---|---|---|---|
| M-07 | Authentication | MVP | Email+password for all internal users, MFA, password reset, lockout, invites, session assurance | — | all internal | auth.users, session_assurance |
| M-08 | Tenant links, trusted devices & PIN quick access | MVP | `/login/[slug]`, device enrolment/revocation, staff picker on trusted devices, PIN set/reset, idle lock + PIN unlock, step-up | M-07 | employees, admin | trusted_devices, member_pins, pin_attempts |
| M-09 | Employees, roles & permissions | MVP | Invite employees, configurable roles from templates, overrides, credentials, deactivate | M-07 | tenant admin, `manage_staff` | tenant_members, tenant_roles, member_roles, member_credentials |

### Tenant setup (Admin)
| ID | Module | Phase | Purpose | Depends on | Roles | Main data |
|---|---|---|---|---|---|---|
| M-10 | Profile, branding & settings | MVP | Legal info, PAN, logo, colours, hours, booking rules, invoice format, day-closing hour, PIN policy, notification options | M-03 | admin, `manage_settings` | tenants, tenant_settings |
| M-11 | Public website manager | MVP | Edit and publish the tenant website: hero, about, contact, hours, announcements, gallery, FAQs, SEO; choose public doctors/services/departments; preview | M-10, M-12, M-13 | admin, `manage_website` | site_settings, site_announcements, site_media, site_faqs |
| M-12 | Departments & services | MVP (BT clinic) | Departments; services with price, duration, public flag | M-10 | admin, `manage_catalogue` | departments, services |
| M-13 | Doctors & schedules | MVP (BT clinic) | Doctor profiles (credential), public profile, fees, weekly templates, leave/exceptions, slot derivation | M-09, M-12 | admin; doctor (own leave) | doctor_profiles, doctor_schedules, schedule_exceptions |

### Clinical operations (Admin + Employee + Patient site)
| ID | Module | Phase | Purpose | Depends on | Roles | Main data |
|---|---|---|---|---|---|---|
| M-14 | Patients | MVP | Register, search, demographics, MRN, duplicate warning, account-link verification | M-07 | front desk, doctor, nurse | patients, patient_account_links |
| M-15 | Appointments | MVP | Desk/phone booking, confirm, reschedule, cancel, no-show; day/week views per doctor | M-13, M-14 | front desk, doctor (own) | appointments |
| M-16 | Public booking & patient accounts | MVP | Tenant site: doctors, services, slots, guest booking, manage link, booking status; optional OTP patient account (my appointments, family) | M-11, M-15 | patients | appointments, patient_accounts, patient_sessions |
| M-17 | Reception check-in & queue | MVP | Check-in, token, live queue per doctor, call next, checkout | M-15 | front desk, nurse, doctor | visits, token_counters |
| M-18 | Consultation & medical history | MVP | Encounter (vitals, complaint, history, exam, diagnosis, plan, follow-up), finalize, addenda, allergies, conditions | M-17 | doctor; nurse (vitals) | encounters, vitals, diagnoses, encounter_addenda, patient_allergies, patient_conditions |
| M-19 | Prescriptions | MVP | Rx items (linked to catalogue items when BT has a pharmacy), allergy check, print/PDF with registration no. | M-18 (M-20 optional) | doctor; front desk prints | prescriptions, prescription_items |

### Pharmacy, inventory & purchasing (Admin + Employee), Revision 3
| ID | Module | Phase | Purpose | Depends on | Roles | Main data |
|---|---|---|---|---|---|---|
| M-20 | Item master & units | MVP | Medicine/consumable catalogue: name, generic, manufacturer, category, dosage form, strength, route, schedule class + Rx-required flag, base/purchase/sale units with conversion factors, barcodes per unit, SKU, min/reorder/max levels (per store overrides), storage condition, active flag | M-10 | inventory manager, pharmacist (`manage_items`) | inventory_items, medicine_details, item_units, item_barcodes, item_categories, manufacturers, generics, store_item_levels |
| M-21 | Stores, lots & stock ledger | MVP | Multiple stores + member assignment; lots (batch, mfg, expiry, cost, MRP, price, block status); append-only movements + balance cache; FEFO allocation; expiry blocking; near-expiry and low-stock alerts; transfers (request → approve → dispatch → receive); adjustments with reasons; stock counts; quarantine and disposal; batch block/recall; opening stock | M-20 | inventory manager, pharmacist, store members | stores, store_members, item_batches, stock_movements, stock_balances, stock_transfers…, stock_adjustments, stock_counts, stock_disposals |
| M-22 | Vendors & purchasing | MVP | Vendors; purchase orders (basic); purchase invoices with batch/expiry/MRP/sale price/free qty/discount/tax per line; cash/online/credit/mixed payment; duplicate-bill guard; purchase returns (credit note or refund); vendor payments (partial, allocated FIFO); vendor ledger | M-20, M-21 | inventory manager (`manage_purchases`), accountant (`pay_vendors`) | vendors, purchase_orders, purchase_invoices, purchase_returns, vendor_payments, allocations |
| M-23 | Pharmacy counter & dispensing | MVP (BT with pharmacy) | Search/scan, unit choice, FEFO suggestion + override, internal Rx dispensing (partial, substitution with reason) and external Rx recording, Rx-required enforcement, OTC sale, returns | M-19, M-21, M-24 | pharmacist, cashier | invoices (item lines), invoice_line_allocations, dispensations, external_prescriptions |

### Money (Admin + Employee), Revision 3
| ID | Module | Phase | Purpose | Depends on | Roles | Main data |
|---|---|---|---|---|---|---|
| M-24 | Sales & billing | MVP (services) / R2 (item lines) | One invoice for services and items; per-lot allocations; discounts (role limits); taxes (P-08); cash/online/mixed receipts; patient/customer association; dues within credit limits; returns per lot; same-day void; printable invoice with batch and expiry; gapless numbering; idempotent posting | M-12, M-17, M-21 | cashier, front desk, pharmacist | invoices, invoice_lines, invoice_line_allocations, payments, payment_allocations, sale_returns |
| M-25 | Expenses & other income | MVP | Overheads by category, cash/online split, reversal-based corrections; other income | M-26 | accountant, admin | expenses, other_income |
| M-26 | Finance journal & balances | MVP | Double-entry journal written by every posting; cash, bank/online, receivables, payables, inventory balances; opening balances; integrity reconciliation | M-22, M-24, M-25 | admin, accountant (`view_finance`) | ledger_accounts, ledger_entries, postings |
| M-27 | Reports & analytics | MVP (appointments, revenue) / R2 (below) | Stock (store/tenant), batch history, expiry, low stock, purchase register, vendor ledger, sales register, **daily sales summary** (store, cashier, method), item sales & margin, **P&L** (revenue, COGS, gross profit, losses, expenses, net profit), cash book, store-wise and tenant-wide | the modules it reports on | admin, report keys | derived |

### Cross-cutting
| ID | Module | Phase | Purpose | Depends on | Roles | Main data |
|---|---|---|---|---|---|---|
| M-28 | Notifications & reminders | MVP (in-app, push, email) | Staff signals; patient confirmations/reminders/changes; stock alerts | M-15 | system, all | notifications, push_subscriptions, notification_outbox |
| M-29 | Audit log | MVP | Sensitive reads and writes, PIN/device events, per-patient access history | M-07 | admin (`view_audit_log`) | audit_log |

### Phase 2 and future
| ID | Module | Phase | Notes |
|---|---|---|---|
| M-30 | Laboratory + Lab dashboard | **Phase 3** | test catalogue, orders, samples, results, report PDF (plan feature) |
| M-31 | Clinical files | **Phase 3** (with lab) | private bucket, signed URLs, audited |
| M-32 | SMS / messaging | **F (dropped from P2, D-136)** | maybe later: outbox channel; patient OTP by SMS (P-05, P-20) |
| M-33 | Patient clinical documents online | P2 | Rx (and later lab) for **verified** account links |
| M-34 | Online payments | P2 | eSewa/Khalti/Fonepay (verify) for bookings, invoices, subscriptions (P-12) |
| M-35 | Follow-ups & referrals | P2 | follow-up booking; referral grants (C4) |
| M-36 | Daily summary email | P2 | HRestroSewa reporting-service shape |
| M-37 | Patient merge | P2 | audited, reversible: **done** (D-138) |
| M-38 | Instant self-serve signup & trial | P2 | auto-provision on verification, trial plan |
| M-39 | Subdomain / custom domain sites | P2 / F | `<slug>.<domain>`, then custom domains |
| M-40 | Insurance (HIB/SSF) | F | verify eligibility and claim rules |
| M-41 | Multi-branch | F | branch_id on scheduling/stores |
| M-42 | Telemedicine | F | |
| M-43 | Interoperability | F | FHIR export, LIS devices |
| M-44 | Payroll & attendance | F | HRestroSewa payroll/rota patterns are available as a reference |
| M-45 | Stock reservations | P2 | hold lots for a patient or Rx awaiting collection; `qty_reserved`; expiry auto-release (`database.md` §9.5) |
| M-46 | Purchase suggestions & supplier performance | P2 | velocity × lead-time reorder suggestions per store; supplier fill rate, on-time rate, return rate, price trend, shelf life at receipt; PO approvals + email to vendor |
| M-47 | Cashier shifts & till reconciliation | **F (dropped from P2, D-137)** | open/close shift per counter, expected vs counted cash, variance posting |
| M-48 | Controlled-drug register | **F (dropped from P2, D-137)**; still **required before controlled/narcotic items can be sold** (P-22) | register of receipt, dispensing, balance, prescriber; stricter disposal |
| M-49 | Advanced barcode | P2 | GS1 DataMatrix parsing (GTIN + batch + expiry), camera scanning on phones, shelf and price label printing |
| M-50 | Accounting export & e-billing integration | F | export journal (CSV/Tally-style); IRD/CBMS real-time invoice reporting if required (P-08) |
| M-52 | Patient advances / deposits | P2 | deposits before procedures, applied to invoices (`PATIENT_ADVANCES` liability; HRestroSewa room-advance pattern) |
| M-51 | Bulk recall | P2 | block a batch number across all stores, notify, list affected sales by patient |

## 2. Feature inventory by area

### 1. Marketing website (M-01, M-02)
Landing (value proposition, screenshots), features by business type, **pricing** rendered
from `plans` where `is_public`, FAQ, contact form and support details (phone, email, hours),
**Register your clinic/pharmacy** (business name, type, owner name, email, phone, address,
PAN optional, plan interest, CAPTCHA, email verification, terms/privacy consent), legal
pages (privacy, terms, DPA summary). SEO metadata, sitemap and robots, modelled on
HRestroSewa's landing.

### 2. Super Admin (M-03–M-06)
Applications queue (approve → provision, reject with reason), tenant list (status, type,
plan, expiry, last active, counts), tenant detail (profile, subscription history, platform
invoices, admin access reset, suspend/reactivate/close), plans CRUD (price, cycle, limits,
features, public flag), platform invoices and payments, expiry warnings, monitoring
(active tenants, bookings/day, invoices/day, notification failures, errors), platform
settings (sender identity, SMS config in P2, feature flags), platform audit. **No patient or
clinical data, ever** (D-08).

### 3. Admin (per tenant)
Dashboard (today's appointments, queue, revenue, low stock, near expiry, dues, payables) ·
Profile & branding · **Website** (M-11) · Employees & roles (M-09), PIN and device
management (M-08) · Departments & services · Doctors & schedules · Patients · Appointments ·
Medicines & inventory items · Stores & stock (transfers, counts, adjustments, expiry) ·
Vendors & purchases · Sales & billing · Expenses · Finance · Reports · Notifications ·
Settings · Audit log.

### 3a. Inventory, pharmacy, purchasing, sales & finance: MVP vs advanced
| Area | MVP (R2) | Advanced (P2 / F) |
|---|---|---|
| Item master | all fields in M-20; units + conversion; multiple barcodes per unit; per-store levels | multi-ingredient generics, interactions, substitutes (P2); platform drug master (P-24) |
| Lots & expiry | lot per receipt; batch/mfg/expiry/cost/MRP/price; expired never allocatable; near/critical expiry alerts; manual block | bulk recall (M-51); GS1 batch/expiry from barcode (M-49) |
| Allocation | FEFO default, FIFO tie-break, manual override with permission | reservations (M-45) |
| Stores | many stores; member assignment; quarantine; per-store levels | branch stores with branch finance (M-41) |
| Transfers | request → approve (setting) → dispatch → receive; transit loss | auto-replenishment from main store (P2) |
| Adjustments & counts | reasons; counts with point-in-time system qty; segregation setting; disposal records | scheduled cycle counts; count freeze windows (P2) |
| Purchasing | PO basic; purchase invoice with batch lines, free qty, discounts, tax; cash/online/credit/mixed; duplicate-bill guard; returns; partial payments with FIFO allocation; vendor ledger | PO approvals + emailing; supplier performance; velocity-based suggestions (M-46); landed cost (F) |
| Sales | search, keyboard-wedge barcode scanners, units, FEFO suggestions, multi-lot lines, discounts within role limits, taxes, mixed payments, patient association, Rx enforcement, returns per lot, same-day void, printable invoice, daily sales summary | camera scanning (M-49); cashier shifts (M-47); online payments (M-34); price schemes and loyalty (F) |
| Controlled drugs | **blocked from sale** until P-22 is decided | register (M-48) |
| Finance | journal; cash, bank, receivables, payables, inventory; exact COGS; P&L; store-wise; reconciliation | accounting export, e-billing (M-50); custom chart of accounts (F) |

### 4. Employee (role-based workspace)
- **Front desk:** today, appointments, quick register, check-in, queue board.
- **My queue / consultation (doctor):** queue, chart, consultation, Rx, follow-up.
- **Vitals (nurse):** checked-in patients, vitals entry.
- **Pharmacy counter:** Rx dispensing queue, OTC sale (scan/search, unit, FEFO lot),
  external Rx recording, returns (request; posting needs A2).
- **Cashier:** open visits to bill, invoices, payments (cash/online/mixed), dues collection,
  receipts.
- **Stock tasks** (in assigned stores only): receive against PO/drafts, transfer requests,
  dispatch/receive, count entry, move expired stock to quarantine.
- **Lab (P2):** worklist and results.
- Always present: my schedule, notifications, profile (password, MFA, PIN), lock screen,
  switch user (trusted device).

### 5. Client / Patient website (M-16)
Tenant home (logo, colours, hero, hours, call button, announcements), about, departments,
services and fees (optional), doctors and profiles (photo, qualification, specialty,
registration no., OPD days), gallery, FAQs, location/contact, **book appointment**
(department/doctor → date → slot/token → details → confirm), booking confirmation and
**status** (requested/confirmed/checked-in/completed/cancelled), manage link (cancel or
reschedule within the rules), **optional account** (OTP sign-up/sign-in, my appointments,
family members, saved details). Clinical documents online come in P2 and need a verified
link. For pharmacy-only tenants the site shows store info, hours and contact, and has no
booking.

## 3. MVP summary
**MVP modules** (backend in Phase 0, screens in Phase 1):
- **Platform:** M-01, M-02, M-03, M-04, M-05 (lite)
- **Access:** M-07, M-08, M-09
- **Setup:** M-10, M-11, M-12, M-13
- **Clinic flow:** M-14, M-15, M-16, M-17, M-18, M-19
- **Pharmacy and money:** M-20, M-21, M-22, M-23, M-24, M-25, M-26, M-27
- **Cross-cutting:** M-28, M-29

Inventory scope detail is in §3a.
**MVP dashboards (D-56):** Admin (`(admin)`), Registrar, Doctor OPD and Pharmacy
(`(employee)` workspaces), plus Marketing, Super Admin and the public clinic site.
**Phase 2:** M-33 online documents, M-34 online payments, M-35–M-39, M-45, M-46, M-49,
M-51, M-52, M-06. **Phase 3:** M-30 lab + Lab dashboard, M-31 clinical files.
**Future:** M-32 SMS (dropped from P2, may or may not come, D-136), M-47 cashier shifts and M-48 controlled-drug register (dropped from P2, D-137), M-40–M-44, M-50.
**Why later:** lab is Phase 3 by owner decision; SMS (provider pending); online clinical
documents (the verification workflow must be proven first); online payments (gateway
contract); instant self-serve (manual approval is safer for the first tenants); support
desk.

### 3b. The four staff dashboards (D-56, D-57)
| Dashboard | Route | Default role template | What it does |
|---|---|---|---|
| **Admin** | `/admin/*` | `tenant_admin` | everything back-office: setup, staff/roles/devices, doctors, services, website, patients, appointments overview, inventory, purchases, vendors, billing, expenses, finance, reports, audit |
| **Registrar** | `/employee/registrar` | Registrar | register/search patients, appointments (book/reschedule/cancel), **registration = check-in with the OPD fee bill + receipt + token**, queue, collections/dues, reprint Rx, other entries the admin permits |
| **Doctor OPD** | `/employee/opd` | Doctor | my queue, call next, patient summary + allergies, consultation, e-prescription → pharmacy queue, follow-up, my schedule/leave |
| **Pharmacy** | `/employee/pharmacy` | Pharmacy | dispensing queue, OTC sale, pharmacy billing + payments + returns, stock (receive, transfer, count, adjust, quarantine), purchases and vendors, alerts |
| **Lab** (Phase 3) | `/employee/lab` | Lab Technician | worklist, samples, results |
Other staff (a nurse, an assistant) get **custom roles** that open the same workspaces with
fewer permissions (e.g. a nurse sees the Registrar queue and enters vitals).

## 4. Module ownership & enablement (Revision 4 audit)
**Owner** = the area that configures and is accountable for the module. **Users** = the
areas that operate it day to day. **Module key** = the `lib/modules.ts` toggle (blank = always
on for the business type).
| Module | Owner | Users | Module key |
|---|---|---|---|
| M-01 Marketing website | Super Admin | prospects | — |
| M-02 Registration & onboarding | Super Admin | prospects, Admin | — |
| M-03 Tenant management, M-04 Plans & platform billing, M-05 Monitoring | Super Admin | Super Admin (Admin sees own subscription) | — |
| M-06 Support desk (P2) | Super Admin | Admin | — |
| M-07 Authentication | Super Admin (platform policy) | everyone internal | — |
| M-08 Tenant links, devices, PIN | Admin | Employee | — |
| M-09 Employees, roles, credentials | Admin | Admin | — |
| M-10 Profile, branding, settings, billing profiles, modules | Admin | Admin | — |
| M-11 Website manager | Admin | Patient (reads) | `website` |
| M-12 Departments & services, M-13 Doctors & schedules | Admin | Employee, Patient (public view) | `appointments` |
| M-14 Patients | Admin (policy) | Employee, Patient (own) | — |
| M-15 Appointments, M-16 Public booking & accounts, M-17 Check-in & queue | Admin | Employee, Patient | `appointments` |
| M-18 Consultation, M-19 Prescriptions | Admin (config) | Employee (doctor, nurse) | `consultation` |
| M-20 Item master, M-21 Stores & stock | Admin | Employee (inventory, pharmacist) | `inventory` |
| M-22 Vendors & purchasing | Admin | Employee (inventory), Admin (accountant) | `purchasing` |
| M-23 Pharmacy counter | Admin | Employee (pharmacist, cashier) | `pharmacy_counter` |
| M-24 Sales & billing | Admin | Employee (cashier, front desk, pharmacist) | — |
| M-25 Expenses, M-26 Finance, M-27 Reports | Admin | Admin, Employee (with keys) | `expenses_finance` |
| M-28 Notifications | Admin (preferences), Super Admin (sender, channels) | everyone | — |
| M-29 Audit log | Admin (tenant), Super Admin (platform events) | Admin | — |
| M-30–M-52 (P2/F) | as M-01–M-29 for their area; patient-facing ones (M-33, M-34) are also used by Patient | | own keys (`lab`, `sms`, …) |
**Every module has an owner. None is ownerless.** Platform-wide modules belong to the Super
Admin, every tenant module to the tenant Admin, and Employee and Patient only operate or
consume them.
**Clinics that skip modules:** a clinic without a pharmacy turns off `inventory` (or keeps it
for consumables), `purchasing` and `pharmacy_counter`. A pharmacy-only tenant has no
`appointments`/`consultation`. Lab is opt-in. See `architecture.md` §2b.
