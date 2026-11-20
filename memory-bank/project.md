# Project: CMediSewa

> **How to use this memory bank.** Read `project.md` → `architecture.md` → `decisions.md` →
> `current-task.md` first. Load `database.md`, `permissions.md` and `security.md` for anything
> that touches data, access or patient information. Edit only the affected files when work
> finishes. `decisions.md` is append-only. Mark claims **Confirmed** / **Assumption** /
> **Recommendation**. Cross-reference IDs: `D-xx` = decision, `P-xx` = pending decision,
> `M-xx` = module (`features.md`), `W-xx` = workflow (`workflows.md`), `A1–A3` = session
> assurance levels (`permissions.md` §2).
>
> **Revision 2 (2026-11-20):** five application areas (separate Admin and Employee), dual
> authentication (email/password + tenant link/PIN quick access), configurable roles,
> pharmacy/inventory/vendors/finance in scope, tenant-managed public website, optional
> patient accounts. Superseded decisions are marked in `decisions.md`.

## Overview
CMediSewa is a multi-tenant SaaS platform for **medical clinics, healthcare centres and
pharmacy/medical operations** in Nepal. It follows HRestroSewa's proven multi-tenant SaaS
architecture and operating structure (`../docs/hrestrosewa-reference.md`), adapted to
healthcare, and it is an independent product with its own database, deployment and
business logic.

A **tenant** is one registered medical business (a clinic, a clinic with a pharmacy, or
later a pharmacy-only or diagnostic business). Each tenant gets its own Admin environment,
Employee workspace and public website, the same way each HRestroSewa restaurant gets its
admin, staff dashboard and QR customer site.

## Product vision
A small clinic or pharmacy in Nepal should be able to run its day on CMediSewa from a phone,
tablet or front-desk PC:
- patients find the clinic's own website, see its doctors and book a slot;
- reception checks them in;
- the doctor consults and prescribes;
- the pharmacy counter dispenses from tracked stock;
- the cashier bills everything on one invoice;
- the owner sees stock, purchases, expenses and the day's finances.

Patient records must be safer than paper: access is limited by care relationship, every
clinical read is audited, and quick PIN access never opens a medical record by itself.

## Target users
- **Platform operator** (Super Admin).
- **Tenant owner/manager** (Admin): often a doctor-owner, sometimes a non-clinical manager
  or pharmacist-owner.
- **Employees** with configurable roles: doctor, receptionist, nurse, pharmacist, inventory
  manager, cashier, lab technician, and any role the tenant defines.
- **Patients/clients**, mostly on phone browsers. Phone is the primary contact and email is
  often missing (**Assumption**).
- **Prospective businesses**, who reach the marketing site and register.

## Target market
Small private clinics, polyclinics, specialist OPD clinics, dental and eye clinics, clinics
with an in-house pharmacy, and small healthcare centres in Nepal. Typical size is 1–15
doctors and 2–30 staff, at one location. **Out of scope:** inpatient wards, OT, multi-branch
chains and insurance claims (future).

## Main objectives
1. Take a tenant from registration on the marketing site to a live public website and
   working front desk without code changes.
2. Cut front-desk friction: online booking, token queue, fast patient lookup, PIN quick
   switching on shared devices.
3. Give doctors a fast consultation and prescription flow.
4. Track medicines and consumables by batch, expiry and store, with purchases from vendors.
5. Keep billing and finance correct: one invoice for services and medicines, sequential
   numbers, and derived balances (HRestroSewa's finance model).
6. Protect patient data: tenant isolation, care-relationship access, assurance levels,
   audit logs, backups.

## How a clinic is staffed (owner, Revision 5)
Every clinic runs **its own pharmacy** under the same PAN. Staff: **Admin** (owner/manager),
**Registrar** (front desk: registration, appointments, the OPD fee bill and all entries the
admin permits), **OPD doctors**, **Pharmacy** (one person who dispenses, sells, bills and
manages stock, purchases and vendors), **Lab** (Phase 3), and **other staff** (custom
roles). Dashboards: **Admin**, **Registrar**, **Doctor OPD**, **Pharmacy**, and **Lab**
(Phase 3) (D-56).

## Core application structure: five areas
| # | Area | Route group (proposed) | Users | HRestroSewa equivalent |
|---|---|---|---|---|
| 1 | **Marketing website** | `(marketing)/` | prospects | `(marketing)` landing |
| 2 | **Super Admin** | `(superadmin)/superadmin/*` | platform operator | `(superadmin)` |
| 3 | **Admin** (per tenant) | `(admin)/admin/*` | tenant admin + employees with management permissions | `(admin)/admin/*` |
| 4 | **Employee**: Registrar, Doctor OPD, Pharmacy (+ Lab in Phase 3) dashboards | `(employee)/employee/{registrar,opd,pharmacy,lab}` | all employees, by role | `(employee)/employee/*` |
| 5 | **Client / Patient website** (per tenant) | `(public)/c/[slug]/*` | patients (guest or optional account) | `(customer)/c/[slug]` QR site |
Plus `(auth)` for the generic and tenant-specific sign-in pages (`/login`, `/login/[slug]`,
`/superadmin/login`).

The **tenant public website is managed from that tenant's Admin** (M-11), the same way a
HRestroSewa restaurant admin manages the menu its QR site shows.

## Scope
**In scope:** marketing site and registration, Super Admin (tenants, plans, platform billing,
monitoring, settings, onboarding), Admin (profile/branding, public website, employees/roles,
doctors/departments, patients, appointments, medicines/inventory, stores, vendors/purchases,
sales/billing, expenses/finance, reports, notifications/settings), Employee workspace, and
the public site (info, doctors, services, slots, booking, status, optional patient accounts).
**Phase 2:** clinical documents online for patients, SMS, online payments, controlled-drug
register, support desk, instant self-serve signup. **Phase 3:** laboratory + Lab dashboard
(`features.md`, `roadmap.md`).
**Out of scope for now:** IPD, OT, insurance claims, telemedicine, LIS/PACS, native apps.

## MVP definition
The MVP is complete when a pilot tenant can:
1. register on the marketing site, be approved by the Super Admin, and receive its admin
   invite;
2. set up branding, its public website, departments, services, doctors and schedules,
   roles and employees, and enrol a reception device for PIN quick access;
3. take an online booking (guest or patient account) without double booking; the
   **registrar** registers the patient, **bills the OPD fee at registration** and issues a
   token;
4. the doctor completes a consultation in the **OPD dashboard** and issues an e-prescription
   (A2+ session);
5. the **pharmacy** dispenses the prescription from tracked batch stock and bills it. The
   OPD bill and the pharmacy bill are separate invoices in the **same** sequential series
   (one PAN, one billing profile);
6. record purchases from vendors (creating batches with expiry), transfer stock between
   stores, and record expenses;
7. see derived finance (cash, bank, receivables, payables), stock and appointment reports;
8. pass the isolation, care-access, assurance-level, concurrency and PHI-leak test suites,
   with verified backups.

Delivery (`roadmap.md`, D-55): **Phase 0** builds the whole MVP database and backend
(B0–B9, tested without UI). **Phase 1** builds the UI outline and the MVP screens (U1–U8)
and ends at the single pilot gate. Modules a tenant doesn't use can be switched off
(`architecture.md` §2b). At launch every tenant is `clinic_pharmacy` (D-58).

## Glossary
- **Tenant**: one registered medical business. It has its own data, admin, employees and
  website.
- **Business type**: `clinic_pharmacy` at launch; `clinic` and `pharmacy` later (D-58). It decides which
  modules exist (HRestroSewa's `restaurants.type` pattern).
- **MRN**: medical record number, unique per tenant.
- **Visit / encounter**: presence at the clinic for a day / one doctor–patient consultation.
- **Token**: daily queue number. **Batch**: a medicine lot with an expiry.
  **Store**: a stock location.
- **Care relationship**: the link that grants clinical access (`permissions.md` §6).
- **Assurance level (A1/A2/A3)**: how strongly the current session was authenticated
  (PIN / password / password+MFA).
- **Trusted device**: a device an admin has enrolled for PIN quick access for one tenant.
- **PHI**: protected health information. **BS/AD**: Bikram Sambat / Gregorian dates.
