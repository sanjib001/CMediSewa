# CMediSewa: Setup and User Guide

For the CMediSewa platform team (Super Admin) and for each clinic's admin and staff.
Written for the app as it is on 21 November 2026. Addresses use `<your-domain>` for wherever
CMediSewa is hosted, and `<clinic-link>` for the short name a clinic is given (for example
`arogya-demo`).

**Contents**

1. How CMediSewa is organised
2. Part A: Super Admin, first-time platform setup
3. Part B: Super Admin, adding a clinic
4. Part C: Clinic Admin, setting up the clinic (in order)
5. Part D: Going live
6. Part E: Daily work, screen by screen
7. Part F: Signing in, PINs, trusted devices and security
8. Part G: Good to know and current limits
9. Quick checklists

---

## 1. How CMediSewa is organised

| Who | Where they work | What they do |
|---|---|---|
| **Super Admin** (the CMediSewa team) | `<your-domain>/superadmin` | Plans, clinics, subscriptions, invoices to clinics, platform health. Never sees patient records. |
| **Clinic Admin** (owner or manager) | `<your-domain>/admin` | Sets up and runs one clinic: settings, staff, doctors, services, medicines, stock, purchases, money, reports, website. |
| **Staff** (registrar, doctor, pharmacist, cashier, nurse, accountant) | `<your-domain>/employee/...` | Their own workspace: Registrar, OPD, Pharmacy. Each person sees only what their role allows. |
| **Patients** | `<your-domain>/c/<clinic-link>` | The clinic's public page: doctors, services, booking requests. |

Every clinic is separate. Staff of one clinic can never see another clinic's data.

A clinic moves through these states:

- **Setting up:** created; the admin can prepare everything; staff and online booking are off.
- **Live:** the admin pressed **Go live**; everything works.
- **Suspended** (set by Super Admin): the admin can read but not change; staff and booking stop.
- **Closed** (set by Super Admin): permanent.

---

## 2. Part A: Super Admin, first-time platform setup

Do this once, before the first clinic.

### A1. Sign in
1. Open `<your-domain>/superadmin/login`.
2. Enter your email and password.
3. The first time, scan the QR code with an authenticator app (Google Authenticator, Microsoft
   Authenticator, Authy). After that, every sign-in asks for the 6-digit code.

> Use a long, unique password and keep the authenticator on a phone only you hold.

### A2. Platform settings (Super Admin → Settings)
- **Support phone, WhatsApp, support email, office address:** these appear on the public
  Contact page.
- **Registrations open or closed:** while you are piloting with one or two clinics, you can
  close the public "Register your clinic" form. A message then tells visitors to contact you.

### A3. Plans (Super Admin → Plans & billing)
Create the plans clinics subscribe to:
- **Name, description, price (Rs.), billing cycle (days)**
- **Max doctors / max staff** (limits per clinic)
- **What it includes** (which modules: appointments, consultation, pharmacy, inventory,
  purchasing, expenses & finance, website)
- **Show on the pricing page:** tick it only for plans you want visitors to see on the landing page.

### A4. Health panel (Super Admin → Overview)
Shows clinics by status, the last nightly check, any clinic whose books or vendor payables
don't match, and whether email is really being sent or running "dry". Look at it once a day
during the pilot.

---

## 3. Part B: Super Admin, adding a clinic

There are two ways. Both end with the same thing: a **one-time setup link** for the clinic
admin and the clinic's own **sign-in address**.

### B1. Way 1: add a clinic yourself (Clinics → Add a clinic)
Use this for clinics you signed up in person.

| Field | What to enter |
|---|---|
| **Clinic name** | As patients know it, e.g. "Sunrise Clinic & Pharmacy" |
| **Clinic link** | Filled in from the name. It becomes `<your-domain>/c/<clinic-link>` and the staff sign-in address. **It can't be changed later**, so check it. |
| Phone, PAN (optional, 9 digits), District, Municipality | The clinic's details |
| **Clinic admin: Name and Email** | The owner or manager who will set the clinic up |
| **Plan, Starts, Days** | Which plan, from when, and for how long |
| **Subscription type** | **Free trial** (default 30 days), **Paid** (default 365 days) or **Complimentary** |

Press **Open the clinic**. You will see two things, **shown only once**:

1. **One-time setup link (for the clinic admin):** send it by WhatsApp, Viber or in person.
   It works once and **expires in 7 days**.
2. **Clinic sign-in address (for the admin and all staff, every day):**
   `<your-domain>/login/<clinic-link>`. Ask them to bookmark it on the clinic's computers.

If the setup link is lost or expires, open the clinic's page and make a **new invite link**.

### B2. Way 2: approve a registration from the website (Applications)
Clinics can register themselves at `<your-domain>/register` (if registrations are open).
1. Open **Super Admin → Applications**. Each one shows the clinic, owner, phone, email and the plan they're interested in.
2. **Call them if needed** to confirm they're real.
3. **Approve:** choose the plan, start date, length and whether it's complimentary. You get the same setup link and sign-in address as in B1.
4. Or **Reject** with a reason (kept in the record).

### B3. Looking after a clinic (Clinics → the clinic)
- **Status:** Active (live), Suspended (read-only admin, no staff or booking), Closed
  (permanent). A reason is required and kept in the record.
- **Subscription:** extend it, or start a new period.
- **Invoices:** issue an invoice to the clinic and **record a payment** (amount, date, reference).
- **Clinic admin:** whether they've signed up yet; make a new invite link if needed.
- **Registrations:** verify a staff member's professional registration (NMC, NPC, etc.) when the clinic has no second admin to do it.

### B4. Audit (Super Admin → Audit)
Every platform action (sign-ins, approvals, status changes, settings) with who did it and when.

---

## 4. Part C: Clinic Admin, setting up the clinic (in order)

The **Admin dashboard shows a setup checklist** ("Getting ready") with each step and a link.
The first three are required before you can go live; the rest are strongly recommended.

### C1. First sign-in
1. Open the **setup link** from CMediSewa.
2. **Choose a password** (at least 10 characters) and repeat it.
3. **Set up your authenticator** (scan the QR code with Google Authenticator or similar) and
   enter the 6-digit code.
4. You land on the **Admin dashboard**. From now on sign in at `<your-domain>/login/<clinic-link>`.

> Admins and doctors always use a password plus authenticator code. Important changes
> (staff, roles, settings) ask you to confirm them again if it has been more than 5 minutes.

### C2. Settings (Setup → Settings) · *required*
**Clinic details:** clinic name, registered name, PAN, registration number, phone, email,
province, district, municipality, ward, street/tole.

**On every bill** (what prints on receipts and bills):
- **Legal name on bills** *(required)*, PAN / VAT number, registration number
- Phone and address on bills
- **Bill number prefix** (e.g. `SC` gives `SC-00001`; numbering restarts each fiscal year)
- **Footer line** (e.g. "Thank you. Get well soon.")

**How the clinic runs:**

| Setting | Options / meaning |
|---|---|
| **OPD style** | Time slots and tokens · Time slots only · Tokens only |
| Book up to (days ahead) | How far ahead appointments can be booked |
| Online booking notice (minutes) | Minimum notice for website booking requests |
| Cancel up to (hours before) | Latest a patient may cancel with their link |
| **Charge the OPD fee** | At registration · After the consultation · Don't charge in the system |
| **Staff PIN** | Allowed on trusted devices · Required on trusted devices · Off (password every time) |
| Lock the screen after (minutes idle) | The "Still there?" lock. On untrusted devices it is never more than 15 minutes. |
| PIN works for (hours after password) | How long a PIN keeps working before a password is needed again |
| **Patients may leave part of a bill unpaid** + **Most a patient may owe (Rs.)** | Untick = every bill is paid in full. Tick it to allow dues, up to the limit per patient. |
| Discount allowed without approval (%) | Bigger discounts need an admin |
| Email a reminder (hours before) | Appointment reminder by email; 0 = off |
| Warn about expiry / Urgent expiry (days before) | When medicines show as "expiring" and "urgent" |
| **Receipt paper** | 80 mm thermal · 58 mm thermal · A5 · A4 |

Saving asks for your password if you haven't entered it recently.

### C3. Departments & services (Clinic → Departments & services) · *required*
- **Departments** (optional): group doctors and services, e.g. General medicine, Paediatrics, Dental.
- **Services:** name, department, **price (Rs.)**, usual length (minutes), description, and
  **Show on website**. You need **at least one consultation service with its fee**
  (e.g. "General OPD Rs. 500", "Follow-up visit Rs. 300"). Procedures like dressing or
  nebulisation go here too.

### C4. Staff & roles (Setup → Staff & roles)
**Roles:** ready-made roles you can use as they are or copy and adjust:

| Role | Opens on | Typical work |
|---|---|---|
| Registrar | Registrar desk | Register patients, book, check in, collect OPD fees, dues |
| Doctor | OPD | Queue, consultation notes, prescriptions, follow-ups |
| Pharmacy | Pharmacy | Dispense prescriptions, counter sales, returns, stock |
| Cashier | Pharmacy | Counter sales and payments |
| Nurse / health assistant | Registrar desk | Front-desk help, vitals |
| Accountant | Admin | Expenses, finance, reports |
| Lab technician | Lab | Phase 3 (not available yet) |

**Invite someone:**
1. Enter the person's name, job title and **either an email or a username** (a username is for staff without email; they sign in on the clinic's own link).
2. Choose their role(s) and press **Create invite link**.
3. Send them the link (valid **7 days**). They choose a password; **doctors and admins** also set up an authenticator.
4. If it expires, press **New invite link** next to their name.

**Registrations (NMC, NPC, NHPC…):** add the registration number and expiry for each doctor,
pharmacist and other licensed staff. **Someone other than that person** (another admin, or
CMediSewa) must verify it. Clinical work is unlocked by a **verified, unexpired** registration: a doctor can't write
consultations or prescriptions (and doesn't appear on the website), and a pharmacist can't
dispense prescriptions, until theirs is verified. When it expires, that work stops until it
is renewed.

### C5. Doctors & schedules (Clinic → Doctors & schedules) · *required*
1. **Add a doctor:** choose the staff member (or **Invite a doctor**), specialty,
   **consultation fee**, departments, and **Show on the clinic website**.
2. Open the doctor and set the **Weekly OPD**: for each day, the clinic hours and either
   **minutes per appointment** (time slots) or **tokens per session** (token OPD). You can have
   a morning and an evening session.
3. **Leave and one-off changes:** mark leave, a different time on one day, or an extra OPD.
   Existing bookings are never moved automatically: the registrar sees them under
   "Appointments to move".
4. **Profile:** qualifications and a short bio for the website.

### C6. Stores (Pharmacy & stock → Stock & stores)
Every clinic starts with a **Pharmacy** store (sellable) and a **Quarantine** store
(not sellable, for damaged, recalled or returned stock). Add more if needed (e.g. a
second counter or a main store). Give each pharmacist **access** to their store(s).

### C7. Medicines (Pharmacy & stock → Medicines)
For each item:
- **Name on the shelf (brand)**, generic name, strength, form/route, manufacturer, category,
  DDA registration number
- **Units:** the smallest unit (tab, cap, ml, sachet) and packs (strip = 10, box = 100…).
  Use **Start from a common pack** to fill these quickly. Set **Usually bought in** and **Usually sold in**.
- **Sale rule:** Over the counter · Prescription only · Controlled / Narcotic (**blocked from sale for now**)
- **Storage:** room temperature, cold chain, frozen, protect from light
- **Stock levels:** reorder at, reorder quantity, critical below, maximum
- **Barcodes:** optional. Add them only if you use a scanner.
- **Returnable to vendor**, **Can be sold loose**

### C8. Opening stock (Stock & stores → Opening stock)
Enter what is on the shelf **on the day you start**, one line per batch: item, unit, quantity,
**batch number, expiry date, cost per unit, MRP per unit**. Check the totals before saving:
stock entries can be corrected, never deleted.

### C9. Vendors (Pharmacy & stock → Vendors)
Add each supplier (name, PAN/VAT, phone, contact person, payment terms in days) and their
**opening balance**: what the clinic already owed them on the start date.

### C10. Opening cash and bank (Money → Finance)
Under **Opening cash and bank**, enter the cash in the drawer and the bank balance on the
start date. Do this once; it starts the books.

### C11. Trusted devices (Setup → Trusted devices)
On **each clinic computer** staff will use (reception PC, pharmacy counter):
1. Sign in there as the admin.
2. Open **Trusted devices** and press **Trust this device**.

Staff can then sign in on that computer with a **6-digit PIN** instead of a password.
On any other device they must use their password.

### C12. Clinic website (Setup → Clinic website)
- **Page content:** headline, one line under it, about the clinic, phone/email/WhatsApp for
  patients, opening hours, map link, accent colour, search title and description.
- **Show fees and prices**, **Take booking requests on the website**.
- **Notices** (with "show until" and "pin to top") and **Common questions**.
- **Publish** it. Your public page is `<your-domain>/c/<clinic-link>`.

---

## 5. Part D: Going live

When the three required steps are done (clinic details and bill header, a consultation
service, a doctor with an OPD schedule), the dashboard shows **Go live**. Anything missing is
listed with a link to fix it.

**Before you press Go live:**
- [ ] Practise on a **separate test clinic**, not the real one. Bills and stock entries can
  be reversed but never deleted, so practice data would stay in the real books.
- [ ] Opening stock, vendor balances and opening cash/bank are entered and checked.
- [ ] Every staff member has signed in once; PINs are set (**My PIN**) where used.
- [ ] Clinic computers are trusted; the receipt printer prints a test OPD token and bill.
- [ ] Doctors' NMC registrations are verified.

After Go live, staff can work, the website takes booking requests (if turned on), and the
nightly books check starts.

---

## 6. Part E: Daily work, screen by screen

Screens update by themselves: a check-in at reception appears in the doctor's queue, and an
issued prescription appears in the pharmacy, within seconds.

### E1. Registrar desk (`/employee/registrar`)
- **Find the patient** by name, phone or MRN, or **Register a new patient** (name, sex, age or
  date of birth, phone, email optional). Likely duplicates are flagged for the admin.
- **Book** an appointment (doctor, day, slot or token) or **check in** a walk-in:
  choose doctor and service, collect the **OPD fee** (cash, eSewa, Khalti, Fonepay, bank),
  and print the **token + receipt**.
- **Queue per doctor:** waiting, with the doctor, done. Links to **Receipt** and **Print Rx**.
- **Booking requests** from the website: confirm or decline (with a reason).
- **Reschedule** or cancel appointments; **Appointments to move** when a doctor is on leave.
- **Patients who owe:** collect dues.
- **Advance** (a tab next to Check in and Book, for staff who take payments): take a deposit
  before an operation or stay (cash or online), and print its **advance receipt** (`AD-…`).
  The advance pays the patient's next bills by itself: at check-in the form shows **From
  the advance** and takes only the rest, even if your clinic doesn't allow dues. Bills
  from before the deposit are paid with **Pay … from the advance**. Unused money can be
  **given back** (with a reason) by staff with billing permission.

### E2. Doctor OPD (`/employee/opd`)
- Your **queue** for today. **Call next**, see the patient's **chart and allergies**.
- **Consultation:** complaint, history, examination, assessment, plan, advice.
- **e-Prescription:** medicines from the clinic's list (or free text), dose, frequency,
  days, quantity, instructions. **Issue** it: it is locked, numbered (`RX-000001`…), and goes
  to the pharmacy queue.
- **Follow-up:** book the next visit from the consultation.
- **My schedule:** add or remove your own leave; the desk is told about affected bookings.

### E3. Pharmacy (`/employee/pharmacy`)

| Tab | What it's for |
|---|---|
| **Dispense** | Issued prescriptions waiting. Open one, the batches are suggested (earliest expiry first), adjust, take payment, print the bill. |
| **Sale** | Counter sales: type or **scan** a medicine, choose the unit (tab/strip/box), quantity; link a patient or record a walk-in; payment (cash/online/mixed). A linked patient's **advance** pays first; take only the rest. Expired and blocked batches are never offered. Prescription-only items need a prescription. |
| **Bills** | Today's and earlier bills: **print**, **return items** (batch by batch, refund or reduce what's owed), **void** (same day only). |
| **Dues** | Patients who owe: collect. |
| **Stock** | What's on hand, transfers between stores, stock counts (PIN level). |

### E4. Admin: the rest of the menu

| Menu | Use it to |
|---|---|
| **Dashboard** | Today: patients booked/registered/waiting/seen, cash and online received, owed by patients, owed to vendors, alerts. |
| **Patients** | Search, open a patient (visits, appointments, bills), edit details, resolve duplicate flags, **combine two records of the same person** (and undo it), the patient's **advance** (take, use, give back). |
| **Appointments** | All bookings by day and doctor. |
| **Purchases** | **New purchase**: enter the supplier's bill (batches, expiry, cost, MRP, free qty, discount, VAT); pay now or on credit. **Orders** (purchase orders), **Returns** to the vendor, void a purchase. |
| **Vendors** | Supplier list, what you owe each, **record payments** against bills, payables check. |
| **Stock & stores** | Needs attention (low, expiring, expired), on the shelf, **transfers**, **counts**, **reorder** list, **dispose** expired or damaged stock, opening stock. |
| **Billing** | Every bill; open, print, see returns and payments. |
| **Expenses** | Record expenses (electricity, rent, salaries, transport…) paid in cash or online; reverse a mistake. |
| **Finance** | Profit and loss for any period, money in and out, cash and bank balances, expenses by category, the nightly **books check**, opening cash and bank. |
| **Reports** | Stock, batch history, expiry, sales register, item sales, purchase register, cash book. Each can be filtered by dates and store, and downloaded as a spreadsheet (**Download CSV**, asks for your authenticator code and is logged). |
| **Audit log** | Who did what and when, including who opened patient records. |
| **Notifications** | Prescriptions to dispense, stock needing attention, booking requests, leave notices. Turn on push for this device to get them when the app is closed. |

**Same patient registered twice.** Open either record in **Patients**. A flagged record lists
the likely match, with a **Same person: combine** link; otherwise use **Combine with another
record** and type the other MRN. Choose which record to keep (usually the older one, with the
lower MRN), tick "I have checked these are the same person" and press **Combine records**.
Visits, appointments, bills, payments, allergies, vitals, consultations and prescriptions all
move to the kept record. The other record disappears from lists, but searching its MRN still
finds the person, so an old card keeps working. The kept record's own details stay, so copy
anything missing (an email, a second phone) before you combine. You can't combine while the
record is in today's queue, or while both records have a booking at the same time. A mistake
can be undone with **Undo** under **Combined records**: the moved records go back. Both steps
are recorded in the audit log, and you need the **manage patients** permission for either.

---

## 7. Part F: Signing in, PINs, trusted devices and security

- **Sign-in address:** `<your-domain>/login/<clinic-link>`, the same for everyone in the clinic.
- **Password** for everyone; **plus an authenticator code** for admins and doctors.
- **PIN** (6 digits): set under **My PIN**. Works only on **trusted devices** and only for
  front-desk and counter work. Patient records and admin screens still ask for the password.
- **Idle lock:** after the set minutes with no activity, a "Still there?" box covers and blurs
  the screen with a 60-second countdown, then signs out. Press **I'm here** to continue.
- **Offline:** a banner shows when the connection drops; work resumes when it's back.
- **Install as an app:** in Chrome or Edge use **Install app**; on a phone use **Add to Home
  screen**. It opens like an app, with its own icon.
- **Never share passwords or PINs.** Every action is recorded against the person signed in.

---

## 8. Part G: Good to know and current limits

- **Nothing is deleted.** Bills are voided or returned; stock and money entries are reversed.
  The books always balance and the trail is kept.
- **Fiscal year:** bill numbers restart each Nepali fiscal year; dates show in BS and AD.
- **Controlled and narcotic medicines can't be sold** in the system yet (register planned for later).
- **Patients have no accounts yet.** They manage a booking with the private link in their email.
- **Email** goes out once a night on the current hosting plan, and only after a mail service is
  connected; until then it runs "dry" (nothing is sent).
- **No SMS** for now. **Online payments** are recorded manually (eSewa/Khalti/Fonepay reference).
- **Patient dues from before go-live** can't be entered yet.
- **English only** for now.
- **Lab** comes in Phase 3.

---

## 9. Quick checklists

### Super Admin: new clinic
- [ ] Plan exists (and is public if it should be on the pricing page)
- [ ] Clinic added (or application approved) with the right **clinic link** (it can't change later)
- [ ] Setup link sent to the admin (expires in 7 days)
- [ ] Sign-in address sent and bookmarked on the clinic's computers
- [ ] First invoice issued / trial dates noted

### Clinic Admin: before Go live
- [ ] Settings: clinic details, **legal name on bills**, bill prefix, receipt paper, OPD style, OPD fee timing, PIN rule, dues limit
- [ ] Services: at least one consultation with its fee
- [ ] Staff invited, roles set, registrations **verified by someone else**
- [ ] Doctors: fee, departments, **weekly OPD**
- [ ] Stores and staff store access
- [ ] Medicines with units and reorder levels
- [ ] **Opening stock** by batch (batch, expiry, cost, MRP)
- [ ] Vendors and **opening balances**
- [ ] **Opening cash and bank**
- [ ] Clinic computers trusted; PINs set
- [ ] Website filled in and published
- [ ] Test print: OPD token, pharmacy bill, prescription
- [ ] **Go live**

### Every day
- [ ] Registrar: check in, collect fees, confirm website requests, collect dues
- [ ] Doctor: queue, notes, prescriptions, follow-ups
- [ ] Pharmacy: dispense queue, counter sales, check "Needs attention"
- [ ] Admin: record purchases and expenses, look at the dashboard and Finance at day end
