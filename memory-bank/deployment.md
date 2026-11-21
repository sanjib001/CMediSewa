# Deployment

Status: **Recommendation.** It mirrors HRestroSewa's production setup, which is confirmed
working (Coolify + self-hosted Supabase on a VPS, `../docs/hrestrosewa-reference.md`), and
hardens it for medical data.

## 1. Environments
| Env | App | Database | Purpose |
|---|---|---|---|
| **dev** | `next dev` locally | Supabase **local** (`supabase start`, Docker) or a hosted dev project; **synthetic data only** | daily development |
| **staging** | Coolify app on the prod VPS or a small VPS | its own self-hosted Supabase (or a separate DB in the same stack) with **synthetic data only** | migration rehearsal, E2E, clinic demos |
| **prod** | Coolify app | self-hosted Supabase, **separate from HRestroSewa's** | real clinics |
**Rule: real patient data never leaves prod.** No prod→dev clones (HRestroSewa has a
`clone-db.mjs`; CMediSewa must not have an equivalent that can point at prod). Debugging
uses synthetic fixtures (`scripts/seed-demo.mjs`).

## 2. Production architecture
```
            DNS (P-01) ──► VPS public IP
                              │ 80/443 only (ufw), SSH key-only on a non-default port
                         Coolify proxy (Traefik/Caddy, auto TLS)
                 ┌────────────┴──────────────┐
          cmedisewa-app (Next.js,        supabase stack (Kong, GoTrue, PostgREST,
          node runtime, standalone)      Storage, postgres-meta, Postgres 15+, pg_cron, pg_net)
                 │                              │
                 └── private Docker network ────┘     Postgres: NO published port
                                                      Kong /pg/*: blocked at proxy (D-15)
          Off-host: encrypted backups → object storage (§8) · uptime monitor · error tracking
```

## 3. Hosting options (P-02, P-09)
| Option | Pros | Cons |
|---|---|---|
| **A. New dedicated VPS (same provider family as HRestroSewa)**, *recommended* | blast-radius isolation from the POS; same proven tooling; can be sized for medical retention | one more server to run |
| B. Same VPS as HRestroSewa, separate Coolify project and Supabase stack | cheapest; one server | a POS incident or compromise affects medical data; resource contention; harder compliance story |
| C. Nepal-based data centre / cloud | may be required by data-residency rules (P-09) | fewer managed options; verify Coolify/Docker support and backup targets |
| D. Hosted Supabase (cloud) + Vercel | least ops | data outside Nepal; cost at scale; HRestroSewa moved off it; SMTP and other constraints differ |
**Default: A**, with C if P-09 finds a residency requirement.

## 4. VPS requirements (MVP, ≤ about 30 clinics; **Assumption**, revisit with load data)
- 4 vCPU, 8–16 GB RAM, ≥ 160 GB SSD (Postgres + storage + 14 days of local dumps).
- Ubuntu LTS, Docker, Coolify. Automatic security updates, fail2ban, ufw (22/custom, 80, 443),
  time sync (NTP; appointment logic depends on it), swap configured.
- Separate disk or volume for `/data` (DB + storage) so the OS disk can be rebuilt.

## 5. Environment variables (names only; values in Coolify secrets and never committed)
| Var | Scope | Notes |
|---|---|---|
| `APP_ENV` | tooling | `development` / `staging` / `production`. The migration runner and DB tests classify a target by this, never by hostname (D-61) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public | Supabase's new-format publishable key (replaces the legacy anon key). It holds **no table grants** (D-18) |
| `SUPABASE_SECRET_KEY` | server | new-format secret key (acts as `service_role`; replaces the legacy service-role key). Server-only; CI greps the client bundle for it |
| `SUPABASE_DB_URL` (+ `REALTIME_DB_URL` from B9) | server | Postgres connection for migrations, DB tests and the LISTEN bus. **Quoted**, with the password URL-encoded (`@` → `%40`) |
| `AUTH_HMAC_SECRET` | server | HMAC key for trusted-device tokens and login-attempt hashes (B1). Rotating it un-trusts every device |
| `CRON_SECRET` | server | guards `/api/cron/*` (constant-time; 404 otherwise). Sent by Vercel Cron as `Authorization: Bearer …` (set the same name in the Vercel project) or by hand as `x-cron-secret`. Scheduled (vercel.json): `daily` at 18:30 UTC = 00:15 NPT (jobs + ledger/payables/books checks) and `dispatch-notifications` at 18:45 UTC, both once a day because the Hobby plan rejects more frequent crons (D-128). On Pro, set the dispatcher to `*/5 * * * *`; or call it every 5 min from an external pinger with `x-cron-secret`. `subscriptions` and `stock` remain for manual runs. Hobby plan: crons once a day only (see D-119) |
| `NEXT_PUBLIC_APP_URL` | public | base URL for invite links |
| `DB_SSL` | tooling | `"false"` only for a plain local/CI Postgres; omitted elsewhere |
| `NEXT_PUBLIC_APP_URL` | public | canonical URL for links in messages |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | mixed | web-push (B9a). Generate a pair per environment with `npx web-push generate-vapid-keys`; only the public key may be `NEXT_PUBLIC_`. Changing the pair switches off every registered device |
| `RESEND_API_BASE` | server | optional; unset in production. Points email at a relay or a local test stub (U7 tests) |
| `RESEND_API_KEY`, `MAIL_FROM` | server | email over HTTPS (B9a). Without them the dispatcher runs dry: emails are marked "skipped (no mail key)". `MAIL_FROM` must be on a domain verified in Resend |
| `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID` | server | P2 (P-05) |
| `CRON_SECRET` | server | constant-time compared on `/api/cron/*` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | mixed | booking CAPTCHA (**[OPEN]** provider) |
| `MANAGE_TOKEN_PEPPER` | server | HMAC pepper for hashing booking manage-tokens |
| `DEVICE_TOKEN_PEPPER`, `PATIENT_SESSION_PEPPER` | server | HMAC peppers for trusted-device tokens and patient session/OTP hashes |
| `SENTRY_DSN` (or equivalent) | server | error tracking with **PHI scrubbing** |
Keep a committed `.env.example` with names and comments only. Env files are named by target
(`.env.local`, `.env.staging`, `.env.prod`). HRestroSewa learned that ambiguous names get
mistaken for prod, so file names here are unambiguous.

## 6. Supabase configuration
- Self-hosted stack via the Coolify Supabase template. Postgres **15+** with the
  `btree_gist`, `pg_cron`, `pg_net`, `pgcrypto` and `pg_trgm` extensions.
- **Auth:** email+password, minimum length ≥ 10, **TOTP MFA enabled**, signup disabled
  (invite-only), redirect URLs allow-listed, JWT signing with asymmetric keys (so
  `getClaims()` verifies locally, as HRestroSewa does after its key rotation), access-token
  TTL around 1h, refresh rotation on.
- **Storage:** `public-assets` (clinic logos, doctor photos) is public. `clinical-files` (P2)
  is **private**, reached only through server-issued signed URLs with a TTL of 60 seconds or
  less after a care check and audit. Upload size limits and MIME allow-lists are set per
  bucket.
- **Grants:** migration 0001 revokes `anon`/`authenticated`, fixes default privileges for
  both grantor roles and grants `service_role` explicitly.
- **Vault** secrets: `app_base_url`, `cron_secret` for pg_cron jobs.
- **Kong `/pg/*`** (postgres-meta) is blocked at the reverse proxy in prod. Tooling uses an
  SSH tunnel to Postgres instead. This deliberately differs from HRestroSewa (D-15).
- Studio is not publicly exposed: SSH tunnel or an IP allow-list only.

## 7. Domain & subdomain strategy (P-01)
- Platform domain **[OPEN]** (e.g. `cmedisewa.com` or `.com.np`; `.np` registration has its
  own process to verify).
- **One host for everything** (D-59, same as HRestroSewa): `<domain>/` marketing,
  `<domain>/login` and `/login/<slug>` sign-in, `/admin/*`, `/employee/*`, `/superadmin/*`.
- `<domain>/c/<slug>`: the **tenant public websites** in the MVP, with patient sessions
  path-scoped (`cm_patient`). Option for `<slug>.<domain>` in P2 via wildcard DNS and
  wildcard TLS (DNS-01 challenge), rewritten in `proxy.ts`. Custom tenant domains come
  later.
- `api` isn't needed, since Server Actions share the app origin. `db.<domain>` / the Supabase
  URL is a separate hostname used server-side and by Auth.

## 8. Build & deployment workflow
1. Develop on a branch. CI runs typecheck, lint, unit tests, **migration replay on an empty
   Postgres**, the RLS/grant posture check and E2E (Playwright) against staging.
2. **DB before app** (HRestroSewa rule): migrations are additive and backward compatible.
   Run `node scripts/migrate.mjs up --env staging`, then `--prod --yes` (hostname-checked).
3. Coolify builds the app image from `main` (Next `output: "standalone"`). The health check is
   `/api/health`, which reports DB reachability and the realtime listener status without
   leaking details. Rollback means redeploying the previous image. Migrations are never rolled
   back destructively; a follow-up migration fixes forward.
4. pg_cron SQL (`supabase/cron/*.sql`) is applied per environment by hand and recorded in
   `current-task.md`.
5. Pin every dependency version. Renovate/Dependabot PRs are reviewed, never auto-merged.

## 9. Backup strategy
- **Nightly logical dump** (`pg_dump -Fc`) by a systemd timer (HRestroSewa pattern) with
  verification (`pg_restore --list`) and 14 local copies kept.
- **Off-site, encrypted** (age/GPG) copy to object storage in a second location every night,
  with **30 daily + 12 monthly** kept (**Recommendation**, aligned with P-10 later).
- **Point-in-time recovery:** WAL archiving (e.g. `wal-g` / pgBackRest) to object storage,
  targeting an **RPO of 15 minutes or less** and an **RTO of 4 hours or less** for the MVP.
- **Storage bucket backup:** nightly sync of the storage volume, also encrypted and off-site.
- **Restore drill monthly:** restore into staging, run the parity check (counts plus derived
  report equality, as in HRestroSewa's `verify-parity.mjs`), and record the result.
- Backups contain PHI, so access to keys and buckets is limited to named operators and logged.

## 10. Logging & monitoring
- **App logs:** structured JSON (pino or console JSON) with request id, clinic id and member
  id. **No PHI in logs:** no names, phones, notes or request bodies. A redaction helper
  wraps the logger.
- **Error tracking:** Sentry (or self-hosted GlitchTip) with `beforeSend` scrubbing,
  replays/PII capture off, and server-side source maps.
- **Uptime:** external monitor on `/api/health` and on the public clinic page.
- **Metrics:** Coolify/host metrics (CPU, RAM, disk), Postgres size, connection count,
  backup age (alert at 26h or more), notification outbox failure rate, and realtime listener
  status. `Server-Timing` headers carried over from HRestroSewa for latency checks.
- **Security monitoring:** failed-login spikes, lockouts, break-glass events (in-app to
  admins plus a daily digest), and unusual chart-read volume per member.
- Log retention 30–90 days (**[OPEN]**, P-10). Audit logs live in the DB and are covered by
  the record-retention policy, not log retention.
