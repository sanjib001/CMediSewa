# Pilot checklist

What stands between today's build and one real clinic using CMediSewa. Phase 0 (backend) and
Phase 1 (screens) are complete; everything below is setup, decisions and checking, not new
features. Written 2026-11-21. Tick items as they're done; **Owner** = you, **Counsel** = a
lawyer or tax adviser, **Claude** = something I can do when you say so.

## 1. Decisions to take first
These can change how bills, dispensing or hosting work, so settle them before the clinic
starts. Each has a working default already built in.

| # | Question | Built-in default today | Who |
|---|---|---|---|
| P-08, P-27 | **Tax and IRD billing rules.** Are the clinic's bills valid tax invoices as printed (PAN, bill numbering per fiscal year, VAT 13% per item/service)? Does billing software need IRD certification for this clinic's size and VAT status? | Bills carry PAN, fiscal-year numbering, VAT per item; services and medicines each have a tax category | Counsel |
| P-09, P-02 | **Where patient data may be stored.** Can it sit with a cloud provider outside Nepal, or must it be hosted in Nepal? | Supabase cloud + Vercel (outside Nepal) | Counsel → Owner |
| P-10 | **How long records are kept, and the consent text** patients see when booking. | Nothing is deleted; consent checkbox on website booking | Counsel |
| P-22 | **Controlled and narcotic medicines.** Sold at the counter or not; what register the DDA requires. | Blocked at the counter (can't be sold) | Counsel/DDA → Owner |
| P-28 | **Customer returns.** May sealed, unexpired packs go back on the shelf? | Yes for sealed, unexpired, non-cold-chain; otherwise quarantine | Owner (pharmacist) |
| P-25 | **Sale price above MRP.** | Refused | Owner |
| P-14 | **Plans and prices** for clinics. | Plans exist in Super Admin; none necessarily public | Owner |
| P-01 | **Domain** (e.g. cmedisewa.com / .com.np). | Vercel's default address | Owner |

## 2. Production setup (separate from development)
Today the only database is development. The pilot needs its own, so test data and real
patients never mix.

- [ ] **Production database:** a new Supabase project (or the self-hosted server, per P-09). Not the dev one. — Owner
- [ ] **Run every migration on it** (`node scripts/migrate.mjs up --env .env.prod --prod --yes`) and the access-rule check (`node scripts/check-posture.mjs --env .env.prod`). — Claude, once `.env.prod` exists
- [ ] **New secrets for production, never copied from dev:** `AUTH_HMAC_SECRET`, `CRON_SECRET`, VAPID keys (`npx web-push generate-vapid-keys`). — Owner (Claude can generate them into a file you keep)
- [ ] **Vercel production environment variables:** `APP_ENV=production`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `AUTH_HMAC_SECRET`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL` (the real address: emailed links and invites use it), `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and later `RESEND_API_KEY`, `MAIL_FROM`. Leave `RESEND_API_BASE` unset. — Owner
- [ ] **Backups:** Supabase point-in-time recovery (paid plan) or a nightly encrypted dump off-site (deployment.md §9), and **one restore drill** before go-live. — Owner + Claude
- [ ] **Domain and HTTPS** pointed at Vercel. — Owner
- [ ] **Super Admin account on production** with two-factor. Use a new, strong password: the one shared in our chat earlier should be treated as exposed and changed. — Owner

## 3. Email and notifications
- [ ] **Resend account, verified sending domain**, `RESEND_API_KEY` + `MAIL_FROM` in Vercel. Until then emails run dry (nothing sent; the Super Admin Health panel says so). — Owner
- [ ] **Send one real confirmation to yourself** and open its "See or cancel" link. — Owner + Claude
- [ ] **How often emails go out:** on Vercel Hobby, once a night (00:30 Nepal). For reminders and confirmations within minutes, either Vercel Pro (set the dispatcher back to every 5 minutes) or an external pinger calling `/api/cron/dispatch-notifications` every 5 minutes with `x-cron-secret`. — Owner
- [ ] **Push on a real phone:** turn on notifications for this device, issue a test prescription, see the push. — Owner

## 4. Platform content (Super Admin)
- [ ] Platform settings: support phone, WhatsApp, email, hours (the public Contact page shows them). — Owner
- [ ] Publish the plans that should show on the landing page. — Owner
- [ ] Registrations open or closed while piloting with one clinic. — Owner

## 5. The pilot clinic (in the app; the Admin dashboard's setup checklist guides it)
- [ ] Create the clinic (Super Admin → Clinics → Add a clinic) and send the admin their setup link.
- [ ] Billing profile: legal name, PAN, address, phone, bill prefix, receipt footer.
- [ ] Services and fees (OPD consultation, procedures).
- [ ] Doctors: profile, fee, room, **NMC registration verified by someone other than the doctor**, weekly schedule.
- [ ] Stores: the pharmacy (sellable) and quarantine stores exist; assign staff to stores.
- [ ] Staff, roles (Registrar, Doctor, Pharmacy) and **PINs**, and enrol the clinic's shared computers as **trusted devices** (PIN sign-in only works on those).
- [ ] Medicines: items with units (tab/strip/box), reorder levels; barcodes only if you scan (optional).
- [ ] **Opening stock** per batch (batch number, expiry, cost, MRP).
- [ ] Vendors and their **opening balances**.
- [ ] **Opening cash and bank** (Finance).
- [ ] Website: details, doctors public or not, publish; then **Go live**.
- [ ] Settings → How the clinic runs: idle lock minutes, cancellation cutoff; **Billing and reminders**: whether patients may leave a due and the most one may owe, the discount allowed without approval, and when reminder emails go (24 h before by default, 0 = off).

## 6. A real-device pass at the clinic
Automated tests check what the server sends; these need a real browser and printer.

- [ ] Install on the reception PC and a phone (Add to Home screen / Install app); iPhone home-screen sign-in.
- [ ] Idle lock: leave a screen alone past the idle time; it counts down and signs out.
- [ ] Turn Wi-Fi off: offline banner; reload shows the "No connection" page.
- [ ] Print on the clinic's printers: OPD token + receipt (80 mm), pharmacy bill, prescription, goods received note.
- [ ] Barcode scanner at the counter, if the clinic has one.
- [ ] Live updates: check in a patient at reception, watch the doctor's queue and the pharmacy update by themselves.

## 7. Dry run, then go-live
- [ ] **Train on a separate test clinic**, not the real one: bills and stock entries can be reversed but never deleted, so practice data would stay in the real books.
- [ ] One rehearsal day per role: registrar (register → check-in → token), doctor (consultation → prescription), pharmacist (dispense → bill → return), admin (purchase → stock → finance → reports).
- [ ] Go-live day: opening stock and cash checked, someone on call, the Super Admin Health panel watched at day end, the nightly books check green next morning.

## 8. Known limits during the pilot (by design or deferred)
- Controlled/narcotic medicines can't be sold (P-22).
- No patient accounts; patients use the private link in their email (D-134).
- Opening patient dues from before go-live can't be entered yet (D-109).
- No SMS (P-05); online payments recorded manually (P-12); English only (P-13).
- Emails go out nightly on Vercel Hobby (D-128).

## What Claude can do next, on request
Run migrations and the access check on
production once `.env.prod` exists; a backup + restore-drill script; a desktop browser pass
in Chrome; and fixes from whatever the real-device pass turns up.
