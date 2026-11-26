# Workflows

The end-to-end flows the data model, permissions and assurance levels must support
(Revision 2: renumbered. Revision 3: W-21–W-30 inventory and finance. Revision 4: W-31
integrated journey, W-32–W-36 audit gaps). Status: **Recommendation.** `RPC:` marks an atomic
database function. `[A1]/[A2]/[A3]` gives the minimum session level (`permissions.md` §3).

**Index by area:** Marketing W-01 · Super Admin W-01, W-33 · Admin W-02, W-03, W-06, W-17,
W-21–W-24, W-26, W-27, W-33–W-36 · Employee W-05, W-07, W-09–W-16, W-25, W-28–W-30, W-32 ·
Patient W-07, W-08, W-18, W-36 · Everyone W-04, W-19, W-20 · **End to end W-31.**

## W-01 Business registration & approval (M-01, M-02, M-03)
1. A prospect opens **Register** on the marketing site and enters the business name, type
   (clinic / clinic + pharmacy / pharmacy), owner name, email, phone, address, optional PAN,
   plan interest and consents, and passes the CAPTCHA.
2. The system creates a `tenant_applications` row (`submitted`) and emails a verification
   link. Clicking it sets `verified`. Unverified applications expire after 7 days.
3. The **Super Admin** [A3] reviews the application (and may call the business), then
   approves or rejects it with a reason.
4. Approval → **RPC `provision_tenant`**: creates the `tenants` row (`pending`), default
   `tenant_settings` and `site_settings` (unpublished), the seeded role templates, a default
   store, a trial or first subscription period, and a `tenant_admin` member, then sends the
   owner an **invite**. Audit `tenant.provision`.
5. The owner accepts the invite, sets a password, enrols MFA (P-11), and lands on the setup
   checklist. The tenant becomes `active` when the checklist's required items are done, or
   when the Super Admin activates it.
*P2 (M-38):* instant self-serve activation on verification, with a trial plan.

## W-02 Tenant setup & website publishing (M-10–M-13)
Admin [A2], guided checklist:
1. Profile and branding: legal name, PAN, logo, colour, hours, contact.
2. Departments → services (price, duration, public).
3. Doctors (W-06) and employees (W-03).
4. Booking rules, invoice format, day-closing hour, PIN policy.
5. Pharmacy business types: stores, opening stock (W-21), vendors.
6. **Website** (M-11): hero, about, announcements, gallery, FAQs, which doctors and services
   are public, SEO. **Preview**, then **Publish** [A2 + recent re-auth], which sets
   `site_settings.published`. The system refuses if `booking_enabled` is on and no public
   doctor has a schedule. Publishing revalidates the tenant's cache tags, and `/c/<slug>` is
   live. Audit `website.publish`.

## W-03 Employees, roles & credentials (M-09)
1. Admin or `manage_staff` [A3 or A2 + re-auth] invites an employee by email, or by username
   if P-18 allows, and assigns one or more roles (templates or custom). Optional permission
   overrides.
2. For clinical or pharmacy roles, the admin records the **credential** (profession,
   council, registration no.). It must be **verified by someone other than the credential
   holder** (D-52): another tenant admin, or, in a single-admin tenant, the Super Admin (who
   sees only the name, profession and registration no., never patient data). All tenant
   admins are notified of every credential change. Without a verified credential, the
   clinical keys stay inactive.
3. The employee accepts the invite, sets a password (and MFA if required), and optionally
   sets a **6-digit PIN** from Profile (allowed only from an A2 session).
4. Changes are audited (`member.roles_change`, `member.credential_verify`). Deactivation
   takes effect on the next request.

## W-04 Sign-in with email & password (M-07)
1. `<domain>/login` or `/login/<slug>`. The user enters email/username and password.
2. Supabase Auth signs them in. If MFA is enrolled or required, a TOTP challenge follows
   (→ `aal2`).
3. The server writes `session_assurance` (A2, or A3 after MFA, `password_auth_at = now`),
   resolves the membership (live), and routes: admin → `/admin/dashboard`, employee → their
   role's home. Super Admin uses `/superadmin/login` with mandatory TOTP.
4. Failed attempts are counted with lockout (Auth rate limits plus an app-level lock per
   account). The response never reveals whether an account exists.

## W-05 Trusted device, PIN quick access, idle lock and step-up (M-08)
**Enrol a device:** an admin [A3 or A2 + re-auth] opens Settings → Devices → "Trust this
device" on the device itself and names it ("Reception PC 1"). Optionally restrict it to
certain members. The server issues a random device token (httpOnly cookie, 400 days) and
stores only its hash. Audit `device.enroll`.
**Quick sign-in:**
1. On a trusted device, `/login/<slug>` shows the staff picker (PIN-enabled, active, allowed
   members only) and a "Use password" link. On an untrusted device it shows
   email/password only.
2. The employee picks their name and enters the PIN. **RPC `verify_pin`** checks the member
   lock and the device throttle, compares the hash and records the attempt.
3. On success, if another user's session exists on this device, it is signed out locally
   first. The server then mints a Supabase session for the member (P-23 mechanism) and writes
   `session_assurance` A1 (`method pin, device_id`). Audit `auth.pin_signin`.
4. The landing page is the employee home. Admin-area links show a lock icon.
**Idle lock:** after `idle_lock_minutes` (default 10 on trusted devices), the screen locks
and the session stays alive. Unlock needs the PIN (or password). If the member's last
password sign-in on this device is within `shift_window_hours` (default 12), the session
keeps its A2 level. Otherwise it drops to A1.
**Step-up:** opening a chart or the Admin area at A1 shows "Confirm it's you": password (+
TOTP if enrolled). This upgrades the current session to A2/A3 and sets `reauth_at`. There is
no second session.
**Switch user:** "Switch user" on the lock screen or the menu signs out locally and goes back
to the picker.
**Revoke:** admin → Devices → Revoke. The cookie becomes useless and the PIN sessions minted
on that device are revoked. Audit `device.revoke`.

## W-06 Doctor setup & availability (M-13)
1. The doctor is an employee with the Doctor role and a verified doctor credential (NMC
   no.).
2. Profile: specialty, qualification, departments, services offered, fee, photo, public
   flag, public slug.
3. Weekly schedule template (slot length or token cap per window, effective dating). The
   exclusion constraint rejects overlaps.
4. Leave or exceptions: slots disappear. Already-booked appointments in the range are listed
   for reception to reschedule (W-18) and are **not** auto-cancelled.

## W-07 Patient registration (M-14, M-16)
**At the desk** [A1]: search by phone, name or MRN first. The system warns about duplicates.
On create, a trigger stamps the MRN and consent is recorded.
**Online, guest:** the booking (W-08) matches or creates the patient by phone + name + age.
A fuzzy match is never auto-merged. It is flagged `possible_duplicate` for reception to
resolve at check-in. Admin → Patients either clears the flag (different people) or combines
the two records (`merge_patients`, M-37, D-138): everything moves to the kept record, the
other hides and its MRN still finds the person; `undo_patient_merge` reverses it.
**Online, optional account:**
1. The patient chooses **Create account / Sign in** on `/c/<slug>` and enters an email (or
   phone once P-05/P-20 allow). **RPC `issue_patient_otp`** is rate-limited, sends a 6-digit
   code (10-min TTL), and responds the same way whether or not an account exists.
2. Correct code → `patient_accounts` row (or the existing one) + `patient_sessions`
   cookie. The patient adds a profile and family members.
3. Booking while signed in auto-creates an **unverified** `patient_account_links` row
   to the patient record used.
4. **Verification:** at check-in, reception confirms the person's identity and taps
   "Verify account link" [A1], which sets `verified_at`/`verified_by`. Only verified links
   will unlock clinical documents online (P2, M-33).

## W-08 Online appointment booking (M-16, M-15)
1. The patient opens the tenant site and chooses a department or doctor, then a date, then a
   slot (or "token for this OPD").
2. Availability comes from `available_slots()` (template − exceptions − active appointments,
   within the notice and window rules).
3. Details: prefilled for account holders. Guests enter name, phone, age/DOB, sex, optional
   email and reason, and consent. CAPTCHA, plus OTP if P-04 requires it.
4. **RPC `book_appointment`**: checks that the tenant is active, the site published, booking
   enabled, the doctor public and active, and the slot valid; enforces per-phone, per-IP and
   per-account caps; matches or creates the patient; inserts with status `confirmed` (or
   `requested` if `auto_confirm_online` is false). **GiST exclusion** → `SLOT_TAKEN` for the
   loser of a race. It creates the manage-token hash, writes outbox rows (confirmation,
   reminder) and audits `appointment.create`.
5. The confirmation page shows the reference no., the AD + BS date, a status badge and the
   manage link. Account holders also see it under "My appointments".
6. Staff get an SSE signal, an in-app notification and an opt-in push with PHI-minimal
   content.

## W-09 Appointment confirmation & status
- **Auto-confirm** (default): `confirmed` immediately and the email is sent.
- **Manual:** `requested` → reception confirms or declines [A1] → the patient is notified.
  Declining frees the slot.
- **Status shown to the patient** (manage link / account): requested, confirmed, checked-in,
  in consultation, completed, cancelled (with reason category), no-show.
- Desk and phone bookings use the same RPC (`source = phone`, `booked_by_kind = member`).

## W-10 Registration / check-in with the OPD fee (M-17, M-24), Registrar dashboard [A1]
1. Find today's appointment, or create a walk-in (patient search/register → appointment
   `walk_in`).
2. Resolve duplicate flags, verify contact details, and optionally verify an account link
   (W-07).
3. **RPC `check_in`** (one posting, `consultation_billing_point = check_in`, D-58): creates
   the visit, assigns the token (row-locked counter), sets the appointment to `checked_in`,
   **creates and issues the OPD fee invoice** from the doctor/service price (a discount
   within the role limit), and records the payment (cash/online/mixed). If payment isn't
   taken, it becomes a due, but only with `allow_credit`. Journal: AR/revenue and
   cash/bank. The queue updates over SSE. **Receipt + token slip print together.**
4. Optional vitals by a nurse role [A1, C3].
5. No-show: automatic by cron after OPD end + grace, or manual. A prepaid OPD fee on a
   cancelled visit is refunded through W-25 (A2 + re-auth).
6. **Patient advance (M-52, D-139):** a deposit (`record_patient_advance`, AD- receipt) is
   held for the patient. Check-in and counter sales take the unpaid part from it first
   (a payment with an advance leg), so no credit is needed for what it covers;
   `use_patient_advance` pays older open bills; a refund gives unused money back (reason,
   `manage_billing`); a void returns the advance leg to the advance.

## W-11 Doctor consultation (M-18) [A2]
1. My Queue → "Call next" → `in_consultation`.
2. "Start consultation". If the session is A1 a step-up is required.
   **RPC `open_encounter`** checks C1 and creates the draft.
3. The chart loads through **RPC `get_patient_chart`** (care check + `patient.chart_read`
   audit in one transaction): allergy banner, conditions, vitals, history (C2).
4. The doctor writes complaint, history, exam, diagnosis, plan and follow-up. Drafts
   autosave.
5. **RPC `finalize_encounter`** freezes the record. Corrections are addenda only.

## W-12 Prescription (M-19) [A2]
1. Rx items. With a pharmacy business type, the doctor picks from `inventory_items` (the
   stock level isn't shown to the doctor by default). Otherwise free text. The printed name
   is always stored.
2. Allergy check: a match forces a confirmation with a reason.
3. **RPC `issue_prescription`**: Rx number, frozen, audited.
4. Print/PDF: tenant header, doctor name, qualification and registration no., patient
   name/age/sex/MRN, AD + BS date, items, advice, follow-up, signature line (P-08/P-22
   format rules to verify).
5. With a pharmacy, the issued Rx appears in the **pharmacy dispensing queue** (W-14).
6. A reprint by front desk needs `print_prescriptions` [A1] and is audited. A mistake means
   cancel (reason) and reissue.

## W-13 Billing & payment (M-24) [A1; corrections A2 + re-auth]
1. **Services invoice:** created by `check_in` (when `consultation_billing_point =
   check_in`, a prepaid OPD ticket) or at checkout by **RPC `create_invoice_for_visit`**.
   Service lines come from the appointment's service or doctor fee (prices snapshotted)
   under the **services billing profile**. Procedure items administered in the clinic can be
   added from the department store (W-32). Pharmacy items are **not** added here: they go on
   the pharmacy invoice (W-14), because one invoice = one billing profile and at most one
   store (D-49).
2. Discounts: within the role's limit at A1. Above it needs `apply_discounts` + A2 + re-auth,
   with the reason recorded.
3. **`issue_invoice(idempotency_key, …)`**, one transaction: the posting row → numbering
   (`document_sequences`, gapless) → for each item line, `allocate()` FEFO in the invoice's
   store → `sale` movements (balances `CHECK ≥ 0`) → journal (AR, revenue, tax, COGS,
   inventory) → audit. A retry with the same key returns the same invoice.
4. **`record_payment`**: cash, online (channel + reference) or mixed (both legs, each the
   same sign, summing to the amount). It is allocated to this invoice. Any remainder is a
   **due** only with `allow_credit`, a named patient, and within the credit limit.
5. Print the invoice: tenant header, PAN, invoice no., AD + BS date, patient/customer, lines
   (each item allocation with batch no. and expiry), discounts, tax, total, paid by method,
   balance due. Thermal 80mm or A4/A5.
6. **Dues collection** later: `record_payment` with FIFO allocation across the patient's open
   invoices (HRestroSewa's FIFO credit settlement).
7. **Void** (same business day only, `void_invoices`, A2 + re-auth): a full reversal
   (stock back to the original lots, refund of the payments, reversing journal). After that
   day, use W-25 (return).

## W-14 Pharmacy counter: dispensing & OTC sale (M-23) [A1]
**Dispensing an internal prescription**
1. The pharmacist opens the **dispensing queue**: issued Rx with undispensed quantities, for
   the pharmacist's assigned dispensing store(s). They see Rx items + the patient's allergies
   only (C7).
2. For each Rx item: the matched catalogue item (or a search if the doctor wrote free text) →
   unit → quantity (default: prescribed minus already dispensed) → **FEFO lot suggestion**
   shown with expiry and price → optional override (`override_batch`).
3. **Partial dispense:** a smaller quantity is fine, and the remainder stays in the queue.
   **Substitution** (same generic, different brand or strength-equivalent) needs a reason
   and records `substituted_item_id`.
4. "Bill": a **pharmacy invoice** is created under the pharmacy store's billing profile,
   with `visit_id` and `patient_id` copied as **references** from the prescription (never
   re-typed), then W-13 steps 3–5. A `dispensations` row is written per Rx item. If the
   tenant has a single billing profile and wants one bill per visit, the setting
   `merge_pharmacy_into_visit_invoice` puts the lines on the visit's draft invoice instead.
   That is allowed only when the visit invoice is still a draft and has no other store.
**Prescription from outside**
- For a `requires_prescription` item without an internal Rx, the pharmacist records an
  **external prescription** (prescriber name, registration no., facility, date; a photo in
  P2) and links the line. Without one, `issue_invoice` refuses (`RX_REQUIRED`).
- Controlled and narcotic items stay **blocked** until M-48 / P-22.
**OTC sale**
1. Scan with a keyboard-wedge scanner (barcode → item + unit) or search by brand, generic or
   SKU. The screen shows the available quantity in this store and the nearest expiry.
2. Choose the quantity and unit (box/strip/tab). The FEFO allocation preview shows which
   lots will be used. A line needing more than one lot shows each lot's batch and expiry.
3. Customer: anonymous (name/phone optional), or link a patient (required for dues or Rx
   items).
4. Payment → issue → print. Expired, blocked and recalled lots are never offered, and the
   allocation function refuses them even if the UI is bypassed.

## W-15 Purchase invoice & goods receipt (M-22, M-21) [draft A1 with `receive_stock`; post A2 with `manage_purchases`]
1. New purchase invoice: vendor, vendor invoice no. and date, receiving store (must be
   `is_receiving` and assigned to the user), optional PO link (lines prefill with the
   outstanding PO quantities).
2. Lines: item → purchase unit → qty, free qty → unit cost, discount %/amount, tax rate →
   **batch no., mfg date, expiry date** → MRP and sale price per unit (sale price defaults to
   MRP). Warnings: expiry already past (refused), shelf life below
   `min_receive_shelf_days`, a known batch no. with a different expiry
   (`BATCH_EXPIRY_MISMATCH`, override with reason), cost above the item's last cost by more
   than X%.
3. Bill-level discount and round-off. **Totals are computed by the server.**
4. Payment now: cash, online, credit, mixed, or partial (cash + online + credit = total).
5. **`post_purchase_invoice(idempotency_key, …)`**: duplicate-bill check (vendor +
   vendor_invoice_no) → **creates one lot per line** (never updates an existing lot) →
   `purchase` movements into the receiving store → journal (Dr inventory [+ input tax];
   Cr cash/bank for paid legs; Cr payable for credit) → the PO's received quantities update
   (derived) → audit.
6. Two-step option: a stock clerk enters the draft at A1 while unpacking. A
   `manage_purchases` holder checks it and posts it at A2.
7. **Mistakes after posting:** void (only if none of its lots has moved since receipt, A2 +
   re-auth) or a purchase return (W-23). Posted lines are never edited.

## W-16 Transfers, adjustments & quarantine (M-21)
**Transfer between stores**
1. **Request** [A1, `transfer_stock` in the destination store]: from store → to store, items
   + quantities (in any unit). Status `requested`.
2. **Approve** [A1/A2, `approve_transfers` in the source store] or reject with a reason.
   This is skipped when `transfer_approval_required` is false.
3. **Dispatch** [A1, `transfer_stock` in the source store]: FEFO lots are proposed (expired
   or blocked lots are excluded unless the destination is quarantine) → dispatch quantities →
   **`dispatch_transfer`** writes `transfer_out` per lot and the journal (Dr in-transit / Cr
   inventory). The transfer slip prints.
4. **Receive** [A1, `transfer_stock` in the destination store]: confirm the received
   quantity per lot and record short or damaged quantities with a reason →
   **`receive_transfer`** writes `transfer_in` and the journal (Dr inventory / Cr in-transit;
   loss Dr INV_LOSS). The status becomes `received` or `partially_received`.
5. Full history: requested, approved, dispatched and received are each stamped with a person
   and time. In transit = dispatched − received − loss.
**Adjustment** [A2, `manage_stock`]: store → lot → qty (±) → **reason** (damaged, expired,
lost, theft, found, correction, internal_use, sample) + note → `post_stock_adjustment` →
movements + journal (loss or gain at lot cost) + audit. `found` with an unknown batch creates
a lot (cost = the last known cost, flagged).
**Quarantine:** expired, damaged or recalled stock is **transferred** to the quarantine store
(steps 3–4, possibly in one step when it's the same premises). From there it can only be
returned to a vendor (W-23) or disposed of (W-26).

## W-17 Expenses, finance & reports (M-25, M-26, M-27)
1. **Expense** [A1 with `add_expenses`]: category, amount, cash/online split, optional store,
   note → `record_expense` → journal (Dr EXP_cat / Cr cash/bank). Today only.
2. **Correction** [A2 + re-auth, `manage_expenses`]: a reversal posting + a new entry. The
   original stays visible.
3. **Other income** [A2]: `record_other_income`.
4. **Opening balances** (once, at go-live) [A2 + re-auth]: cash and bank opening, opening
   stock per store/lot (W-21), opening vendor payables per vendor, opening patient dues per
   patient. Each is an `opening` posting against OPENING_EQUITY.
5. **Finance report** [A2, `view_finance`] for a period: opening and closing **cash, bank,
   receivables, payables, inventory value**; flows: sales revenue (services vs pharmacy),
   cash received by method (including dues collected), refunds, purchases (cash / online /
   credit), vendor payments, purchase returns, expenses, other income. HRestroSewa's report
   layout, built from journal sums.
6. **P&L** [`view_financial_reports`]: revenue − COGS = gross profit − inventory losses −
   expenses + other income = **net profit**, tenant-wide or per store.
7. Exports (CSV) [A3].

## W-18 Cancellation & rescheduling (M-15, M-16)
- **Patient** (manage link or account): cancel before the cut-off. Reschedule = **RPC
  `reschedule_appointment`** (new slot checked by the exclusion constraint, old one marked
  cancelled with "rescheduled"), and the outbox notifies.
- **Staff** [A1]: the same RPCs with a mandatory reason.
- **Doctor leave:** the affected list → bulk reschedule or cancel with notices.
- Late cancellations and no-shows per phone feed the booking caps.

## W-19 Notifications & reminders (M-28)
- **Patient outbox:** confirmation, 24h reminder (configurable), rescheduled, cancelled,
  doctor on leave. The cron route `/api/cron/dispatch-notifications` runs every 5 min and
  sends pending rows with retries. `unique (ref, kind, channel)` gives exactly-once
  delivery. Cancelling an appointment cancels its reminders.
- **Content rule:** tenant name, doctor, date/time, token, manage link, phone. **Never**
  diagnosis, reason or Rx.
- **Channels:** email (MVP), SMS (P2, P-05).
- **Staff:** in-app plus push, recipients resolved through the visibility predicate. Push
  shows tokens and doctor names, and patient names only if the tenant enables it. Inventory
  alerts (low stock, near expiry) go to inventory roles.
- **Platform crons:** subscription expiry → suspend, no-show marking, near-expiry scan,
  session_assurance and OTP pruning, retention jobs (P-10).

## W-20 Account recovery & access support (M-07, M-08)
- **Forgotten password (email account):** "Forgot password" → Supabase recovery email →
  set a new password. All the user's sessions are revoked. **The PIN is reset to "must
  change"**, so it is re-set from the next A2 session.
- **Forgotten password (username account, P-18):** the admin [A3 or A2 + re-auth] issues a
  one-time reset code that the employee uses to set a new password. Audited.
- **Forgotten PIN:** sign in with the password (A2) → Profile → set a new PIN. An admin can
  also force a PIN reset or unlock a PIN lockout (audited).
- **Lost device:** admin revokes it (W-05). **Lost phone with MFA:** the admin resets the
  member's MFA after verifying identity in person. The Super Admin does this for tenant
  admins.
- **Tenant admin locked out:** the Super Admin [A3] re-invites them or resets access after
  an out-of-band identity check. Audited.
- **Patient account:** OTP sign-in is the recovery. Lost access to the email or phone means
  reception updates the contact details after an identity check, and the account then
  re-verifies.

## W-21 Item setup & opening stock (M-20, M-21) [A2, `manage_items`]
1. Create the item: type, name, generic, manufacturer, category, dosage form, strength,
   route, schedule class (sets Rx-required), storage condition.
2. Units: the base unit (smallest unit sold), then purchase and sale units with factors (e.g.
   tab ×1, strip ×10, box ×100). Barcodes per unit.
3. Levels: tenant-wide min, reorder and max, with optional per-store overrides. Default sale
   unit.
4. **Opening stock** at go-live [A2 + re-auth]: per store → item → lot (batch, mfg, expiry,
   qty, cost, MRP, sale price) → `post_opening_stock` → one lot per line, `opening`
   movements, journal (Dr inventory / Cr opening equity). It is allowed once per (store,
   item). Later additions go through purchases or `found` adjustments, so opening stock can't
   be used to paper over shortages.
5. Bulk import (CSV) for items and opening stock, with a dry-run validation report,
   following HRestroSewa's `import-menu` script idea but in-app and admin-only.

## W-22 Purchase order (M-22) [A2, `manage_purchases`]
1. Create a PO: vendor, deliver-to store, lines (item, unit, qty, expected cost). It can be
   seeded from **purchase suggestions** (W-28).
2. Mark it `sent` (print or share as PDF; email in P2).
3. Receiving happens in W-15 with the PO linked. Each purchase invoice line can reference a
   PO line, so the received quantity is derived and the PO moves to `partially_received` or
   `received`. Close or cancel the remainder manually.
4. **Approval limit (M-46, D-144):** with `po_approval_limit` set, an order above it (or with
   a line of unknown cost) raised by someone without `manage_settings` is `pending_approval`;
   `manage_settings` holders are notified and approve (→ `open`) or reject with a reason
   (→ `cancelled`), never their own order. It can't be received until approved.
5. Expected date: draft orders from Reorder get today + the vendor's delivery time, which the
   on-time rate measures. Later: vendor emailing.

## W-23 Purchase return to vendor (M-22) [A2, `return_to_vendor`]
1. Choose the vendor, then the store, then lots. Lots from a linked purchase invoice are
   preselected. Allowed: active, blocked, recalled or expired lots, including from
   quarantine.
2. Quantity per lot (≤ on hand in that store, and ≤ received on the linked invoice − already
   returned), reason, settlement (**credit note**, which reduces the payable, or **refund**
   in cash/online).
3. **`post_purchase_return`** writes `purchase_return` movements at lot cost and the journal
   (Dr payable or cash/bank; Cr inventory). A credit note auto-allocates FIFO against the
   vendor's open invoices. The return note prints.

## W-24 Vendor payment (M-22) [A2, `pay_vendors`]
1. The vendor screen shows the payable, open invoices with outstanding amounts and their age,
   recent payments and returns (**vendor ledger**).
2. Enter the amount and method (cash, online with channel and reference, or mixed). It can
   be partial.
3. Allocation: automatic FIFO (oldest invoice first) or chosen manually per invoice. Any
   excess becomes a **vendor advance**.
4. **`record_vendor_payment`**: journal (Dr payable/advance; Cr cash/bank). The voucher
   prints. A mistaken payment is reversed by a reversal posting (A2 + re-auth).
5. **Using credit later (D-143):** `apply_vendor_credit` allocates unallocated payments and
   unused credit notes to open bills, oldest first (Dr AP_VENDORS / Cr VENDOR_ADVANCES).

## W-25 Sales return & cancellation (M-24) [request A1; post A2 + re-auth, `sale_returns`]
1. Find the original invoice (number, patient, scan the receipt). **No return without the
   original invoice** in the MVP.
2. Choose lines. Each line shows its **allocations (lots)**. Enter the return quantity per
   allocation (≤ sold − already returned).
3. Restock decision per line: **sellable** (only if the lot is unexpired and unblocked, the
   item is returnable, and the pack is sealed, as confirmed by the pharmacist), **quarantine**,
   or **none** (destroyed).
4. Settlement: refund (cash/online) or reduce the patient's due.
5. **`post_sale_return`**: `sale_return` movements into the chosen store at the original lot
   (identity preserved, so batch-wise sales and returns history stays exact) → journal
   (revenue reversal, AR, COGS/inventory or loss) → refund posting → audit.
6. **Cancellation** = W-13 §7 (void), same day only.
7. **[OPEN] P-22:** whether returns of prescription-only or cold-chain medicines may be
   restocked at all. The default is quarantine-only for cold-chain items.

**Pharmacy track additions (D-141):** a prescription can be dispensed in parts (the queue
shows what is left); a return can be settled into the patient's advance; every return has a
printable slip.

## W-26 Expiry management & disposal (M-21)
1. **Daily job:** near-expiry (≤ `near_expiry_days`) and critical (≤
   `critical_expiry_days`) lists per store, sent to inventory members as a digest plus a
   dashboard widget. Suggested actions: sell first (FEFO already does this), return to vendor
   (if `is_returnable_to_vendor` and within the vendor's terms), or transfer to a busier
   store.
2. **On expiry:** the lot is automatically unsellable (a date check) and appears in the
   "Expired: move to quarantine" task list.
3. Move to quarantine (W-16 transfer). The value stays in inventory and is reported as
   "expired stock at cost" (at-risk value).
4. Resolution: **return to vendor** (W-23), or **dispose** [A2, `dispose_stock`]:
   `post_disposal` with method, contractor, witness and date → `disposal` movements + journal
   (Dr INV_LOSS) → a disposal certificate upload (P2). Controlled drugs follow M-48 / P-22.

## W-26a Batch recall (M-51) [A2, `block_batches`]
1. A recall notice names a medicine and a batch. Admin → Stock → Recalls: medicine, batch
   number, reason, notice reference → `recall_batch`: every lot of that item with that batch
   number becomes `recalled` in every store (history + audit), so FEFO and a chosen lot both
   refuse it.
2. Holders of `block_batches` and `pharmacy_sell` are notified (in-app + push).
3. The recall page lists stock left per store (→ quarantine → vendor return or disposal,
   W-23 / W-26) and the bills that sold it with the patient or walk-in phone (audited read),
   printable for the file.

## W-27 Stock audit / physical count (M-21) [count A1; post A2, `manage_stock`]
1. Create the count: store, scope (full, category or selected items), **blind** (the system
   quantity is hidden from counters) or open.
2. Counters enter quantities per lot (scanning a box adds units). Each line records
   `counted_at`, and the system quantity *as of that moment* comes from the ledger, so live
   sales during the count don't distort the variance.
3. Review the variances (quantity and value). Recount lines that look wrong.
4. **Post** (a different member from the counter if `count_post_requires_other_member`):
   `count_variance` movements + journal (loss or gain) + audit. The count report prints.
5. P2: a scheduled cycle-count plan (ABC by value), and count freeze windows.

## W-28 Low stock & purchase suggestions (M-21, M-22; advanced M-46)
1. After every stock-reducing posting and daily: for each store × item, available (on hand
   − reserved, sellable lots only) is compared with the store override or the item's
   min/reorder levels.
2. **Below reorder** → added to the **purchase suggestion list** with suggested qty =
   `reorder_qty`, or (max − available − on order from open POs). **Below min** → a critical
   alert (in-app + push to the store's inventory members).
3. For the pharmacy counter, the suggestion may be "transfer from main store" when the main
   store has stock (the suggestion type picks transfer before purchase).
4. Select suggestions → create a PO (W-22) or a transfer request (W-16).
5. **M-46 (done, D-144):** `purchase_plan`: use per day = (sales − sale returns + transfers
   out) over 30/60/90 days. A store × item is suggested at its reorder level, or when on hand
   + on order won't last the vendor's delivery time + 7 days. Qty = per day × (delivery time +
   cover days, default 30), at least the levels, − on hand − on order, rounded up to the
   purchase unit. Vendor = the one it was last bought from. `vendor_performance`: fill rate,
   on-time rate, delivery days, return rate, price changes, shelf life at receipt, on the
   vendor page. Vendors are not ranked against each other (yet).

## W-29 Daily close & sales summary (M-24, M-27)
1. At the tenant day boundary (`day_closing_hour`), or on demand, the **daily sales
   summary** per store and per cashier shows: invoices issued (count, value), revenue split
   (services/pharmacy), discounts, tax, returns, voids, **cash received**, **online received
   by channel**, mixed count, dues created, dues collected, and closing cash and bank
   balances.
2. Printable and exportable. In P2 it is emailed to the owner (M-36, HRestroSewa's daily
   report service, with exactly-once delivery).
3. P2 (M-47): cashier shifts with an expected vs counted cash variance posting.

## W-30 Medicine reservation (M-45, P2)
1. When dispensing is partial because stock is short, or the patient will collect later, the
   pharmacist reserves specific lots for that patient/Rx with an expiry (e.g. 48h).
2. `stock_reservations` raises `qty_reserved`, so others can't sell the reserved quantity
   (available = on hand − reserved).
3. Collection converts the reservation into the sale allocation. Expiry or cancellation
   releases it (by cron).
4. MVP behaviour without reservations: stock is allocated only at invoice issue, and the
   dispensing queue shows a "stock short" flag.

## W-31 Integrated patient journey: booking to finance (Revision 4)
How the modules connect, with each step's single source of truth (`architecture.md` §2c).
| # | Actor / area | Step | Writes | Reads (references only) | Signals |
|---|---|---|---|---|---|
| 1 | Patient / public site | Books Dr. X, 10:30 (W-08) | `patients` (match or create), `appointments`, outbox | public doctor + slots | SSE `appointments`, in-app to reception + Dr. X, email confirmation |
| 2 | Registrar / Employee [A1] | Confirms or edits the booking (W-09) | `appointments.status` | — | patient notice |
| 3 | Registrar [A1] | Registration/check-in (W-10): OPD fee invoice issued + paid, token | `visits`, token, (invoice, payment, journal) | appointment → patient, doctor | SSE `queue` |
| 4 | Nurse [A1] | Vitals (C3) | `vitals` (visit) | visit | — |
| 5 | Doctor, OPD dashboard [A2] | Consultation (W-11) → finalize | `encounters`, diagnoses | visit, patient chart (audited read) | — |
| 6 | Doctor [A2] | Prescription (W-12), items picked from the catalogue when `pharmacy_counter` is on | `prescriptions`, `prescription_items` | encounter, allergies, items | dispensing queue (SSE `queue`) |
| 7 | Pharmacy dashboard [A1] | Dispense (W-14): FEFO lots in the pharmacy store, partial/substitute | pharmacy `invoice` + lines + **allocations**, `dispensations`, `sale` **movements**, journal (AR, revenue, COGS, inventory) | Rx items (visit/patient by reference), lots | SSE `stock`, `billing`; low-stock alert if crossed |
| 8 | Pharmacy [A1] | Payment, cash/online/mixed | `payments` + allocations, journal (cash/bank, AR) | invoice | SSE `finance` |
| 9 | Registrar [A1] | Checkout (only extra services; the OPD fee was already billed at registration) | invoice, payment, journal | visit | queue closes |
| 10 | System | Reports and dashboards | — | journal + documents | daily summary (W-29) |
**Consistency guarantees:**
- Steps 3, 7, 8 and 9 are each one posting (one transaction, idempotent).
- Stock leaves only the invoice's store.
- Dispensed qty = Σ invoice lines linked to the Rx item, so it can't drift.
- The patient's balance = Σ invoices − Σ allocations, across both billing profiles.
- An appointment cancelled after check-in can't be completed. A visit can't be closed while
  an invoice of that visit is still a draft (warning) or any due exceeds the credit rules.
**Module-off variants:** no `pharmacy_counter` → step 6 prints the Rx and steps 7–8 don't
exist. No `appointments` (pharmacy-only) → the journey starts at step 7 with an
external/OTC sale. No `inventory` → invoices hold service lines only.

## W-32 Items administered or used in the clinic (inventory module on)
1. A procedure that bills an item (an injection, dressing set): on the services invoice, add
   an item line from the **department/procedure store** (the store must share the services
   billing profile). The allocation and movement work as in W-13.
2. Consumables not billed to the patient (gloves, cotton): an `internal_use` adjustment [A2]
   per period, or per procedure when the setting is on. Journal: Dr INV_LOSS (internal use
   sub-reason) / Cr INVENTORY.
3. Replenishment: the department store requests a transfer from the main store (W-16).

## W-33 Tenant subscription, suspension, closure & data export (Super Admin, Admin)
1. **Renewal:** the Super Admin issues a `platform_invoice` for the next period, records the
   payment and extends `tenant_subscriptions`. The tenant admin sees the status and invoices
   in Admin → Subscription.
2. **Expiry warnings:** 30, 14, 7 and 1 days before, in-app plus email to the tenant admin.
3. **Expiry:** daily cron → `suspended`. The Admin area becomes **read-only** (exports
   allowed), and the Employee area, PIN sign-in and public booking are off. The public site
   shows a "temporarily unavailable" contact page. **No data is deleted.**
4. **Reactivation:** payment recorded → `active` immediately.
5. **Closure** (tenant request or Super Admin, A3): a final export (an encrypted archive of
   patients, clinical records, invoices, stock and journal as CSV/PDF, delivered to the
   tenant admin) → `closed` → retention per P-10, then deletion with an audit record.

## W-34 Employee offboarding
Admin [A3 or A2 + re-auth] → Deactivate member. This immediately:
- denies access (live membership check) and revokes all sessions;
- removes the member from the staff pickers and trusted-device allow-lists, and disables
  their PIN;
- keeps the member's `store_members` rows for history but makes them inactive;
- reassigns their **future appointments** (doctors), which reception must handle (list
  shown);
- leaves open drafts (purchase, count) for another member to take over.
Historical records keep the member reference. Audited.

## W-35 Fiscal year rollover (Nepali FY, Shrawan 1)
- Document numbering resets automatically: `document_sequences` is keyed by fiscal year,
  computed by `lib/clinic-time.ts` from the tenant-local BS date of the posting.
- Balances need no closing entries: cash, bank, AR, AP and inventory carry forward because
  they are sums. A year-end P&L report is produced. Income and expense accounts are reported
  per period. A formal year-end closing journal is **[OPEN]** (accountant preference, P2).
- A year-end stock count (W-27) is recommended and prompted.

## W-36 Patient data requests (privacy; to verify, P-10)
1. The patient asks at the desk (or through their account in P2) for a copy or correction.
2. Reception verifies identity [A1] and logs the request. The admin [A2 + re-auth] produces
   the export (demographics, visits, encounters, prescriptions, invoices), which is audited
   and watermarked.
3. Corrections: demographics are edited (audited). Clinical content is corrected only by the
   authoring doctor's addendum (D-12).
4. Erasure requests: restrict and anonymise contact fields where the law allows. Clinical and
   financial records are retained as required.
