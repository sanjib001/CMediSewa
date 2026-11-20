# UI / UX

Status: **Recommendation** (Revision 2: five areas, separate Admin and Employee shells, PIN
and lock screens, website manager, pharmacy and inventory screens). Visual design is not
final. A design pass (tokens, type, components) happens in U1 (Phase 1) and is reviewed by the
owner.

## 1. Design direction
- **Calm, clinical, trustworthy.** A light neutral canvas, one primary colour (medical teal
  or blue, **[OPEN]**), and semantic colours used only for meaning: red = allergy, critical
  or expired; amber = waiting, late or near expiry; green = done or paid.
- **Speed at the desk and counter:** frequent actions are one tap away, search is always
  reachable (`/` on desktop), barcode-scanner input works in item search, and the keyboard
  works on PCs.
- 16px base, touch targets of 44px or more, WCAG AA contrast, tabular numerals for money,
  quantities, tokens and times.
- Dark mode for internal areas (token-driven, using HRestroSewa's theme toggle/sync). The
  HRestroSewa CSS traps (`@theme inline`, `fill-mode: both`) are not reintroduced.
- Bilingual-ready: layouts tolerate Devanagari strings, with a Noto Sans Devanagari
  fallback. AD + BS dates wherever patients or printouts see a date.
- **Every area is visually distinct**, so users always know where they are: marketing
  (brand-led), Super Admin (dense, neutral, no tenant branding), Admin (tenant logo,
  management chrome), Employee (task-focused, larger controls), Patient site (the tenant's
  own theme).

## 2. Marketing website
A hero (value + "Register your clinic/pharmacy" + "See pricing"), features by business type,
screenshots, a **pricing** table from public plans (monthly/yearly toggle if cycles allow),
testimonials (later), FAQ, contact (phone, email, hours, form), and legal pages. The
**registration** form is single-page with clear sections and inline validation, and ends on
a "Check your email" screen. Mobile-first, fast and SEO-friendly. HRestroSewa's landing is
the structural reference.

## 3. Super Admin
Sidebar: Dashboard · Applications · Tenants · Plans · Billing · Monitoring · Settings ·
Audit. Applications use a review layout (details | checks | approve/reject). Tenant detail
has tabs (Profile, Subscription, Invoices, Access, Activity). Destructive actions (suspend,
close) open a red confirm dialog with a reason field. It never shows patient data.

## 4. Admin (per tenant)
```
┌─────────────┬────────────────────────────────────────────────────────────┐
│ Tenant logo │ Top bar: tenant name · global search · bell · area switch  │
│             │          (Admin ⇄ Employee) · user menu                    │
│ Dashboard   ├────────────────────────────────────────────────────────────┤
│ Patients    │                                                            │
│ Appointments│  Content                                                   │
│ Doctors     │   Dashboard: KPI tiles (today's appointments, checked in,  │
│ Inventory ▸ │   revenue, dues, payables, low stock, near expiry) +      │
│  Items      │   alerts list + quick links                                │
│  Stores     │                                                            │
│  Transfers  │                                                            │
│  Counts     │                                                            │
│ Purchases   │                                                            │
│ Vendors     │                                                            │
│ Billing     │                                                            │
│ Expenses    │                                                            │
│ Finance     │                                                            │
│ Reports     │                                                            │
│ Website     │                                                            │
│ Staff & roles│                                                           │
│ Settings    │  (Profile & branding, Departments & services, Booking,     │
│ Audit       │   Invoicing, Devices & PIN, Notifications)                 │
└─────────────┴────────────────────────────────────────────────────────────┘
```
- Items are hidden when the business type doesn't have the module (no Inventory for a clinic
  without stores, no Appointments for pharmacy-only) or when the member lacks the
  permission.
- **Setup checklist** on first run: Profile → Departments/Services → Doctors → Roles &
  staff → Stores & opening stock (pharmacy) → Booking rules → Website → Devices.
- **Website manager:** a split view with a section editor on the left (hero, about,
  announcements, gallery, FAQs, visibility toggles for doctors and services, SEO) and a
  **live preview** on the right (phone/desktop toggle). The top shows Draft/Published state
  with "Preview link" and "Publish" buttons. Publishing asks for re-auth.
- **Staff & roles:** the members list (roles, credential status, PIN on/off, last active), a
  role editor with one control per section (None / View / Full + extras, HRestroSewa-style)
  where credential-gated keys show "needs credential", and Devices (enrolled devices, last
  used, revoke).
- **Inventory:** the items list with on-hand by store, low and near-expiry chips, and an
  item detail with batches (expiry, MRP, on hand per store) and a movement history (like
  HRestroSewa's `product_history`).

## 5. Employee workspaces: Registrar, Doctor OPD, Pharmacy (+ Lab in Phase 3) (D-56)
- **Shell:** a large-control layout. A bottom tab bar on phones and a left rail on
  tablets/PCs. A member lands on their role's dashboard. A member with several roles gets a
  workspace switcher (e.g. Registrar ⇄ Pharmacy). Always available: notifications, my
  schedule, profile (password, MFA, PIN), lock, switch user.
- **Registrar dashboard** (`/employee/registrar`):
  ```
  ┌ Today ───────────────┬ Queue (per doctor) ─────────┬ Quick actions ──────────┐
  │ booked 32 · arrived  │ Dr. Sharma  #14 in room      │ [Register / Check-in]   │
  │ 20 · waiting 6       │   #15 waiting 12m            │ [New appointment]       │
  │ appointments list    │ Dr. Karki   #08 in room      │ [Collect due] [Reprint] │
  │ (status chips)       │                              │ search patient (/)      │
  └──────────────────────┴──────────────────────────────┴─────────────────────────┘
  ```
  **Register / Check-in** is one flow: find or create the patient → choose doctor/service →
  **OPD fee bill** (price from the service, discount within limit) → payment
  (cash/online/mixed) → **print receipt + token**. The patient joins the doctor's queue.
  Other entries the admin permits (vitals for a nurse role, expenses, etc.) appear as extra
  panels.
- **Doctor OPD dashboard** (`/employee/opd`): my queue (token, name, wait) → "Call next" →
  **Consultation screen**: a patient header (name, age/sex, MRN, red **allergy banner**), a
  vitals strip, sections (complaint, history, exam, diagnosis, plan, follow-up) and an
  **e-prescription builder** (catalogue search by brand/generic, dose/frequency/duration,
  quick repeat) → "Finalize and send to pharmacy" (+ print). Opening it from an A1 session
  shows the step-up dialog first. Also: today's list, my schedule and leave.
- **Pharmacy dashboard** (`/employee/pharmacy`): tabs
  - **Dispense:** Rx queue → item rows with suggested FEFO batch, expiry and qty,
    substitution and partial options → bill;
  - **Sale:** scan/search → cart (units, batch preview) → payment → print;
  - **Bills:** today's invoices, returns, dues collection;
  - **Stock:** on-hand by store, low and near-expiry lists, receive, transfer, count,
    adjust, quarantine;
  - **Purchases:** purchase invoices, POs, vendors, vendor payments.
  Tabs appear only if the member has the keys. Expiry is colour-coded. Prescription-only
  items show a badge. Actions needing a password show a lock icon.
- **Lab dashboard** (`/employee/lab`, Phase 3): a worklist, sample status, result entry
  and verification.
- **Lock screen:** tenant logo, the member's name and avatar, a PIN pad, "Use password",
  "Switch user". The screen behind is blurred and no patient data is visible.

## 6. Sign-in screens
```
 <domain>/login/<slug>       (trusted device)          (untrusted device)
 ┌──────────────────────────────┐                     ┌──────────────────────────────┐
 │  [Tenant logo]  Tenant name   │                     │  [Tenant logo]  Tenant name   │
 │  Who's signing in?            │                     │  Email or username            │
 │  ( Anita R. ) ( Dr. Sharma )  │                     │  Password                     │
 │  ( Bikash K. ) ( Sita M. )    │                     │  [Sign in]  Forgot password?  │
 │  ── then 6-digit PIN pad ──   │                     │  (no staff list is shown)     │
 │  Use email & password instead │                     └──────────────────────────────┘
 └──────────────────────────────┘
```
Generic `/login` = the email/password form plus "Find your clinic" (a narrow name search, as
in HRestroSewa's `searchRestaurants`, which leads to the untrusted view). A **step-up
dialog** is a modal asking for the password (and TOTP) with a one-line reason ("Opening a
medical record needs your password").

## 7. Responsive strategy
Reception and pharmacy PCs (≥1280px) get two-pane layouts. Tablets (768–1279px) get a
collapsible rail and tabbed consultation. Phones (<768px) get bottom tabs, single-column
forms and tables turned into cards. Nothing scrolls horizontally.

## 8. Client / Patient website
Mobile-first and light, mostly Server Components with minimal JS, themed by the tenant's
`theme_color` and logo.
Sections are toggled by the admin: hero (name, hours, call, Book), announcements, about,
departments, services and fees, doctors (cards → profile page), gallery, FAQs, location,
contact. The header has "Book appointment" and "Sign in" (optional account).
SEO: per-tenant metadata, `MedicalClinic` / `Pharmacy` / `Physician` JSON-LD, sitemap.

## 9. Appointment booking experience
```
1 Choose ──► 2 Pick time ──► 3 Your details ──► 4 Confirm ──► ✓ Booked
 dept or      date strip       prefilled if       summary,       ref no., status badge,
 doctor       + slot chips     signed in; else    consent,       manage link, "Create an
              (or token)       name, phone, age,  CAPTCHA        account to track your
                               sex, email (opt)                  bookings" (optional)
```
At most four steps, and the back button keeps entered data. Only real availability is
shown. If a race happens: "That time was just taken, here are the nearest open times." The
confirmation is printable. The **status page** (manage link or My appointments) shows a
status timeline with cancel/reschedule buttons that respect the cut-off. Account sign-in
uses a two-screen OTP (destination → code) with resend throttling shown.

## 10. Reusable components
From HRestroSewa (restyled): Button, Input, Skeleton, SearchSelect, PeriodFilter, CountPill,
ThemeToggle/Sync, PaymentMethodPicker, StationChips-style filter chips (for stores), and the
PWA set (InstallPrompt, OfflineGate, PushPrompt, RegisterSW, PullToRefresh).
New: PatientHeader + AllergyBanner, StatusChip, SlotPicker, DateStrip (AD + BS), TokenBadge,
VitalsStrip, RxItemRow, BatchPicker (FEFO, expiry colour), StockBadge (low/near-expiry),
Cart/InvoiceEditor, KPI Tile, DataTable→Cards wrapper, AuditTrail, ConfirmDialog with
reason, **StepUpDialog**, **PinPad**, **StaffPicker**, **LockScreen**, SiteSectionEditor,
SitePreviewFrame, PrintLayout (Rx, receipt, token slip, purchase GRN).

## 11. Integration additions (Revisions 3–4)
- **Store switcher** in the Employee and Admin top bars for members assigned to more than one
  store. The current store scopes stock screens, the counter and receiving. Its name is always
  visible on sales and receiving screens, so stock never leaves the wrong store by accident.
- **Transfers inbox** per store: requests to approve, dispatches to receive, discrepancies.
- **Billing profile** shown on every invoice and receipt header (legal name, PAN). In a visit
  view, the patient sees one statement listing the services invoice and the pharmacy invoice.
- **Admin → Modules:** toggles with dependency hints ("Pharmacy counter needs Inventory").
  Turning a module off asks for confirmation and states that data is kept.
- **Setup checklist** items appear only for enabled modules. "Go live" shows what's left.
- **Visit timeline** (front desk and admin): booking → check-in → vitals → consultation →
  prescription → dispensing → invoices → payments, each step linked to its record (with the
  clinical steps hidden from non-clinical roles).
- **Suspended tenant banner** (W-33): read-only mode with an export button. The public site
  shows a contact page.
