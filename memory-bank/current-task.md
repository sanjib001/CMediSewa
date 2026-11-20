# Current Task

**Phase:** Phase 0 backend: **B2 Platform is done** (with its U2 Super Admin + marketing screens). B1 done, U1 outline done. Next: **B3 Tenant setup**.
**Last updated:** 2026-11-20

## B2 Platform: done (2026-11-20)
| Item | Status |
|---|---|
| Migrations 0014–0017: plans, subscription periods, platform invoices/payments/sequences, applications, invites, stores (Pharmacy + Quarantine), provision_tenant, accept/reissue invite, expiry job, status changes; plan features in effective_modules; chained paid-until; invite status columns | done |
| Marketing: `/register` (honeypot, rate limits, no email enumeration), live pricing from public plans | done |
| Super Admin: Applications (approve → one-time invite link / reject with reason), Clinics list + detail (subscription periods, invoices, payments, admin invite re-issue, status with reason), Plans; overview shows waiting registrations and platform activity | done |
| `/invite/[token]`: owner sets password → linked as clinic admin → 2FA step | done |
| `/api/cron/subscriptions` (secret-gated); `CRON_SECRET`, `NEXT_PUBLIC_APP_URL` added | done (not scheduled yet: hosting) |
| Demo clinic: demo plan + 1-year complimentary period, stores added | done |
| Checks | typecheck ✓ lint ✓ build ✓ · unit 16/16 · DB 30/30 · posture ✓ · **B2 end-to-end 35/35** (registration incl. honeypot/no-enumeration → Super Admin password+TOTP → plan → approve → invite → owner account → billing → status → cron) · B1 end-to-end 20/20 still passing · no secrets in client bundles |
| Bugs found & fixed by the tests | posture: platform_payments tenant key (0015); paid-until ignored renewals added in advance (0016); clinic page 500 on member_invites permission (0017); test-harness FormData encoding |
| Left in the dev DB by tests | closed clinics named "E2E test clinic … (safe to ignore)", inactive e2e plans, deactivated throwaway e2e operators |
| Not yet | email verification/emailed invites (needs mail), CAPTCHA (needs Turnstile keys), scheduled expiry job (needs hosting), clinic-admin "Go live" from the setup checklist (B3), support desk (P2) |

## B1 Identity & access: done (2026-11-20)
| Item | Status |
|---|---|
| Migrations 0009–0013: permission/module/template catalog (generated), members, roles, overrides, credentials, PINs, trusted devices, attempts, session assurance, functions (effective_permissions/modules, resolve_request_context, PIN, devices, lockout, credential verification), reserved slugs | done |
| Defaults: P-11 MFA (platform admin, clinic admin, doctors) · P-18 usernames (clinic link) · P-19 6-digit PIN · P-30 credential verifier | applied |
| P-23 PIN → session spike | proven, adopted (D-67) |
| Server: `lib/auth/{context,guards,session,hmac,shell-props}.ts`, `app/actions/staff-auth.ts` (password, MFA, PIN, step-up, set PIN, trust/revoke device, sign-out), `proxy.ts` (staff redirects + remembered clinic) | done |
| Screens wired: `/login`, `/login/[slug]` (trusted device → staff picker + PIN; else password), `/login/mfa`, `/login/verify`, `/employee/pin`, `/admin/devices`; Admin/Employee layouts guarded; sidebar and workspaces filtered by permissions | done |
| Dev seed: demo clinic `arogya-demo` (admin, registrar, doctor, pharmacy), credentials in gitignored `scripts/dev-users.local.json` | done |
| Checks | typecheck ✓ lint ✓ build ✓ · unit 16/16 (incl. TS↔SQL parity) · DB 22/22 · posture ✓ · **end-to-end against the running app 20/20** (wrong password, username rules, registrar/pharmacy sign-in and desks, admin/doctor held at 2FA, PIN picker only on trusted devices, wrong/right PIN, A1 cannot enter Admin or change PIN) · no secrets in client bundles |
| Not verified by me | completing the authenticator step for the clinic admin/doctor (needs a person with an authenticator app) and a visual check in a browser |
| Deferred | idle-lock screen UI (U-phase), admin screens for staff/roles/credentials (U3 on B3), notification of other admins on credential changes (needs B9 notifications), clean empty-DB replay since 0008 (CI job not run yet) |

## Super Admin sign-in + dashboard: first real B1/U2 slice (2026-11-20)
| Item | Status |
|---|---|
| `platform_admins` (migration 0008) + `scripts/create-platform-admin.mjs` | done; Super Admin `cmedicare@gmail.com` exists on dev |
| `proxy.ts` (session refresh, signed-out redirect only), `lib/supabase/{server,service}.ts`, `lib/auth/{current-user,guards}.ts`, `lib/audit.ts` | done |
| L1 flow: `/superadmin/login` (password; non-admins get the same generic error and are signed out) → `/superadmin/login/mfa` (first time: QR enrolment; then 6-digit code) → aal2 → `/superadmin` | done; every step audited (`auth.superadmin_*`) |
| Guard `requireSuperAdmin()` = session + active platform_admins row (live) + aal2, in the layout and every page | done |
| Dashboard `/superadmin`: real clinic counts/list (empty state until B2), platform activity from audit_log, platform facts. No tenant patient/stock/money data (D-08) | done |
| Sign out (local scope) | done |
| Checks | typecheck ✓ lint ✓ build ✓ unit 10/10 ✓ DB 13/13 ✓ posture ✓ · signed-out redirects ✓ · MFA probe on the dev project (password → aal1 → TOTP → aal2, wrong code rejected; ES256 tokens verified locally) ✓ · no secret key in client bundles ✓ |
| **Not yet verified** | the full click-through in a browser (Chrome cannot reach localhost from this setup). Owner to sign in at `/superadmin/login` with an authenticator app ready |
| Not yet built | app-level lockout (Supabase Auth's own rate limit applies), account recovery for platform admins, IP allow-list (P-32), clinic approval/provisioning (B2) |

## U1 Design system & shells: status (2026-11-20)
| Item | Status |
|---|---|
| Tokens, Mukta typeface, focus/reduced-motion floor (`app/globals.css`, `app/layout.tsx`) | done |
| Primitives: Button, StatusChip, PageHeader, Panel, DemoNotice, AllergyBanner, Icon; **OPD ticket** | done |
| Shells: Admin (sidebar), Employee (workspace tabs + phone bottom bar), Super Admin (ink bar), tenant bar | done |
| Screens (demo data, inert forms): marketing landing · `/login` · `/login/[slug]` (trusted-device staff picker + 6-digit PIN pad, or password) · Admin dashboard (+ every menu item routed) · Registrar desk (register → OPD fee → token) · Doctor OPD (queue + consultation + e-Rx) · Pharmacy (dispensing queue + stock alerts) · Lab (Phase 3 note) · Super Admin clinics · public clinic site `/c/arogya-demo` | done |
| Checks | typecheck ✓ · lint ✓ · build ✓ (14 routes) · HTTP smoke test of every route ✓ |
| **Visual review in a browser** | **not done**: Chrome showed an error page for localhost:3000 although the server answered 200. Owner to review at `http://localhost:3000`, plus a phone-width check |
| Next in Phase 1 | owner feedback on the look → U3 Admin screens / U4–U6 desks as their backend milestones land; B1 sign-in is needed before any real screen |

## Status
- Project folder `Downloads/CMediSewa` (git remote `github.com/sanjib001/CMediSewa`).
  HRestroSewa was read only and never modified. Nothing is committed (the owner drives git).
- Revisions:
  - **R1:** analysis.
  - **R2:** five areas, dual auth, roles, website, patient accounts.
  - **R3:** inventory, pharmacy and finance.
  - **R4:** integration audit.
  - **R5:** owner answers on staffing, dashboards and phases.
- **Revision 5 owner decisions (Accepted):**
  - every clinic has its own pharmacy;
  - dashboards: **Admin, Registrar, Doctor OPD, Pharmacy**, with **Lab in Phase 3**;
  - the Pharmacy person = pharmacist + cashier + stock manager;
  - **one PAN / one bill series**, and billing is done by permitted staff;
  - the **OPD fee is taken at registration** by the registrar;
  - **Phase 0 = database + backend**, **Phase 1 = UI outline + MVP**, Phase 2 = next features,
    **Phase 3 = lab**.
  - Recorded as D-55 to D-58. This resolved P-17, P-21, P-29 and P-31. D-54 was superseded
    (the old MS/R1/R2/Gate labels are retired).
- Decisions D-01…D-59 (D-59: one host, owner) · pending P-01…P-32 (resolved: P-06, P-17, P-21, P-29, P-31) · modules
  M-01…M-52 · workflows W-01…W-36 · milestones B0–B9 (Phase 0), U1–U8 (Phase 1).

## Phase 0 plan (from `roadmap.md`)
B0 Foundation → B1 Identity & access → B2 Platform → B3 Tenant setup → B4 Clinical ops (incl.
registration + OPD fee) → B5 Inventory → B6 Purchasing → B7 Sales & billing → B8 Finance &
reports → B9 Realtime/notifications/jobs. Exit: every MVP workflow (W-31 as an executable
script) passes through actions/RPCs in automated tests on staging.

### B0 Foundation: status (2026-11-20)
| # | Task | Status | Evidence |
|---|---|---|---|
| 1 | Next.js scaffold (pinned, TS strict), five route groups on one host | **done** | `npm run build` passes; routes `/`, `/c/[slug]`, `/login`, `/admin`, `/employee`, `/superadmin` (placeholders) |
| 2 | Migration runner (dev/staging/prod interlocks via `APP_ENV`, dev-only `reset`) | **done** | `scripts/migrate.mjs`, `scripts/lib/db.mjs` |
| 3 | 0001 access posture | **done** | + 0006 (posture check found TRUNCATE/TRIGGER/REFERENCES/MAINTAIN on service_role) |
| 4 | Tenancy core: tenants, billing_profiles, tenant_settings, tenant_modules, audit_log (append-only) | **done** | migration 0003 |
| 5 | Posting core: postings, document_sequences, ledger_accounts (auto-seeded), ledger_entries, balance trigger, `ledger_writer`, reversals | **done** | migrations 0005 + 0007 (fixed an ambiguous-column bug the tests caught) |
| 6 | `lib/clinic-time.ts` (Kathmandu time, BS, fiscal year, business day), `lib/modules.ts`, fiscal calendar 0004 | **done** | generated by `scripts/gen-fiscal-calendar.mjs`, cross-checked between two libraries |
| 7 | Checks | **done locally** | lint ✓ · typecheck ✓ · unit tests 10/10 ✓ · DB tests 13/13 ✓ · posture ✓ · **full replay from an empty dev schema ✓** |
| 7b | CI workflow (`.github/workflows/ci.yml`): static job + empty-Postgres replay job | **written, not yet run** | needs a push to GitHub (no Docker on this machine to try the DB job locally) |
| 7c | Staging on Coolify | **blocked** | P-02 hosting / P-09 residency |
| — | `proxy.ts` session refresh, Supabase SSR clients | moved to **B1** | they belong with auth |

**Dev database:** hosted Supabase project in `.env.local` (Postgres 17.12, direct IPv4
connection works). `.env.local` holds only APP_ENV, the URL, publishable key, secret key and
DB URL. Duplicates and the derivable JWKS URL were removed, and the password is now
URL-encoded. The file is gitignored.

**Next: B1 Identity & access.** Supabase SSR clients + `proxy.ts`, invites, email/password,
Super Admin TOTP, `platform_admins`, `tenant_members`, roles/permissions engine with the
TS/SQL parity test, `session_assurance` + `resolve_request_context`, then the **P-23 spike**
(server-side session after PIN) before trusted devices and PIN. Needs P-11, P-18, P-19, P-30.

## Decisions still needing the owner
**Before B0 starts:**
- approve the architecture (D-01…D-59), especially D-06 (admin has no automatic clinical
  access), D-27 (email/password + PIN), D-38 (stock balance cache), D-43 (finance journal)
  and D-55 (backend-first phases);
- **P-26** finance engine: B0 built the journal (D-43) as recommended; say so if you want the pure-derivation alternative instead;
- **P-09/P-02** data residency and hosting (needed for staging and prod planning, not
  for local B0 work).

**Before B1:**
- **P-11** 2FA scope;
- **P-18** usernames for staff without email;
- **P-19** PIN length (6 recommended);
- **P-30** who verifies credentials in a single-admin clinic;
- P-23 is decided by the B1 spike.

**Before B3–B4:**
- **P-03** slots vs tokens;
- **P-07** admin clinical access / doctor history window;
- **P-20** patient OTP channel;
- **P-32** Super Admin IP allow-list.

**Before B5–B7:**
- P-24 drug master;
- P-25 price above MRP;
- P-28 restocking returns.

**Before go-live (legal):**
- P-08 tax and IRD;
- P-10 retention and consent;
- P-14 pricing;
- P-22 drug rules, including whether the Pharmacy person must hold a pharmacist
  registration;
- P-27 tax on medicines and services.

**Later:** P-01 domain (needed by staging/U2), P-04, P-05, P-12, P-13, P-15, P-16.

## Open questions for the owner
- Does the clinic use time slots or daily tokens for each doctor (P-03)?
- Is the pharmacy person a registered pharmacist (affects the credential gate on dispensing,
  P-22)?
- Should the GitHub repo be private?
