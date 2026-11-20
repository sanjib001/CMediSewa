# CMediSewa

**CMediSewa** is a planned multi-tenant SaaS platform for **medical clinics, healthcare
centres and pharmacy/medical operations in Nepal**. It follows HRestroSewa's multi-tenant
structure, with five application areas:

1. **Marketing website**: product, pricing, registration of new businesses, contact.
2. **Super Admin**: tenants, applications, plans and platform billing, monitoring, settings.
3. **Admin** (per tenant): profile and branding, the tenant's public website, employees and
   roles, doctors, departments, patients, appointments, medicines and inventory, stores,
   vendors and purchases, sales and billing, expenses and finance, reports, settings.
4. **Employee**: a role-based workspace (front desk, doctor, nurse, pharmacy counter,
   cashier, stock tasks…), with configurable roles.
5. **Client / Patient website** (per tenant): branding, information, doctors, services,
   available slots, booking, booking status, optional patient account. It is managed from
   that tenant's Admin, the same way a HRestroSewa restaurant manages its QR menu site.

Internal users sign in with **email + password** (MFA for sensitive roles). Employees can
also use HRestroSewa-style **tenant link + PIN quick access on trusted devices**. A PIN never
opens medical records on its own (see `memory-bank/permissions.md` §2–3).

> **Status: Phase 0 (database & backend) in progress. B0 Foundation is done locally; next
> is B1 Identity & access.** Phase 1 builds the UI outline and MVP; lab is Phase 3. See
> `memory-bank/current-task.md`.

## Getting started (development)

```bash
npm install                    # exact pinned versions
cp .env.example .env.local     # fill in the dev Supabase values (never commit .env.local)
npm run migrate                # status against the dev database
npm run migrate:up             # apply pending migrations
npm run db:posture             # verify the access posture (RLS, grants, ledger guard)
npm test                       # unit tests (lib/)
npm run test:db                # DB behaviour tests (transactions are rolled back)
npm run lint && npm run typecheck && npm run build
npm run dev                    # http://localhost:3000
```

## Who it is for

| User | What they do |
|---|---|
| Platform operator (Super Admin) | Registers clinics, manages plans/subscriptions, monitors the platform. **Never sees patient data.** |
| Prospective business | Registers on the marketing site and is approved by the Super Admin. |
| Tenant Admin (owner / manager) | Runs one tenant end to end, including its website, inventory and finance. No implicit access to medical records. |
| Employees | Configurable roles (doctor, receptionist, nurse, pharmacist, inventory manager, cashier, lab technician, custom). Each sees only the modules **and the patient records** their roles, credentials, session level and care relationship allow. |
| Patients | Book as a guest or with an optional OTP account on the tenant's website; manage and track bookings. |

## Architecture at a glance

```
                 ┌──────────────────────── one Next.js app ───────────────────────┐
 Browser  ──►    │ (marketing) (public)/c/[slug] (auth) (admin) (employee) (superadmin)│
                 │      │             │               │         │          │       │
                 │      └──── Server Components + Server Actions (the only API) ─┘ │
                 │                    │ service_role, server-only                  │
                 └────────────────────┼───────────────────────────────────────────┘
                                      ▼
            Supabase (self-hosted): Postgres + RLS deny-all backstop + RPCs,
            Auth (email+password, TOTP MFA), Storage (public: logos; private: clinical)
                                      │
            pg_cron → secret-gated cron routes (reminders, subscription expiry)
            LISTEN/NOTIFY → SSE realtime bus (topic names only, never row data)
            web-push (VAPID) · Resend email (HTTPS) · SMS provider (pending)
```

Full detail: `memory-bank/architecture.md`.

## Proposed technology stack

Inherited from HRestroSewa, where it has been running in production. See `memory-bank/decisions.md`
(D-01 onward) for the reasoning and the alternatives considered.

- **Next.js** (App Router, Server Components, Server Actions) + **React** + **TypeScript** (strict)
- **Tailwind CSS v4**, `radix-ui`, `lucide-react`
- **Supabase**: Postgres, Auth, Storage, self-hosted, managed by **Coolify** on a VPS
- **web-push** (VAPID), **SSE** over Postgres `LISTEN/NOTIFY`, **Resend** (email over HTTPS),
  **pdf-lib** (prescriptions, receipts, reports), `pg` (migration runner, realtime listener)
- Dependency versions **pinned exactly**. HRestroSewa uses `latest`; CMediSewa deliberately does not.

## Repository layout

```
CMediSewa/
├── README.md                 ← you are here
├── memory-bank/              ← the project's source of truth (read first)
│   ├── project.md            vision, scope, users, MVP definition
│   ├── architecture.md       system design, auth, tenancy, realtime, PWA, deployment shape
│   ├── database.md           proposed data model, constraints, isolation, audit
│   ├── features.md           full feature inventory by surface and phase
│   ├── permissions.md        roles, permission keys, record-level (care-relationship) access
│   ├── ui-ux.md              design direction, navigation, booking UX
│   ├── workflows.md          end-to-end clinic and patient workflows
│   ├── deployment.md         environments, VPS, env vars, backups, monitoring
│   ├── security.md           threat model, RLS strategy, audit, Nepal compliance to verify
│   ├── roadmap.md            phases, implementation order, milestones
│   ├── decisions.md          decision log (D-xx accepted/proposed, P-xx pending)
│   └── current-task.md       where the project is right now
├── docs/
│   └── hrestrosewa-reference.md   what was analysed in HRestroSewa and what is reused
├── app/                      five route groups: (marketing) (public)/c/[slug] (auth)
│                             (admin) (employee) (superadmin), placeholders until Phase 1
├── lib/                      clinic-time.ts (Kathmandu time, BS, fiscal year), modules.ts (+ tests)
├── supabase/migrations/      ordered SQL migrations (YYYYMMDDHHMMSS_name.sql)
├── scripts/                  migrate.mjs, check-posture.mjs, gen-fiscal-calendar.mjs, lib/
├── tests/db/                 DB behaviour tests (access posture, posting core)
├── tests/ci/                 CI bootstrap for an empty Postgres
└── .github/workflows/ci.yml  lint · typecheck · unit · build · empty-DB replay · posture · DB tests
```

Folders are added when a module needs them, not ahead of time. The layout follows HRestroSewa's.

## How the memory bank is organised

1. Start every session with `project.md` → `architecture.md` → `decisions.md` → `current-task.md`.
2. Read `database.md`, `permissions.md` or `security.md` only when the task touches data,
   access or patient information. Most clinical tasks touch all three.
3. When work finishes, edit only the affected files. Move finished work out of
   `current-task.md`. Add real architectural choices to `decisions.md` and never delete old
   entries from it.
4. Never duplicate. Structure goes in `architecture.md`, reasons in `decisions.md`, tables in
   `database.md`, access rules in `permissions.md`.
5. Every statement is marked as one of three kinds: **Confirmed** (verified in code or by the
   owner), **Assumption** (believed true, unverified) or **Recommendation** (proposed, awaiting
   review).

## Architectural reference: HRestroSewa

CMediSewa borrows HRestroSewa's proven *patterns* (multi-tenant shape, server-only data
access, local JWT verification, permission sections, SSE realtime, PWA posture, cron and
email services, migration tooling). It does **not** borrow restaurant tables, business logic
or assumptions. The two projects share no database, no deployment and no code dependency.
`docs/hrestrosewa-reference.md` records exactly what was analysed and what is reused.

HRestroSewa is at `../RestroSewa` (the sibling folder on the development machine).
