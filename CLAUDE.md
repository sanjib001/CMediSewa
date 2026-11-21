# CMediSewa

Multi-tenant clinic + pharmacy SaaS for Nepal (Next.js 16, Supabase, pg, Vercel).

**At the start of every conversation, read `memory-bank/current-task.md` → "Resume here" first.**
It says where the work stands, what's next, how the owner works, and how to test. Then read
`memory-bank/decisions.md` (latest decisions) and, for pilot work, `memory-bank/pilot-checklist.md`.
Other references: `memory-bank/roadmap.md`, `features.md`, `architecture.md`, `database.md`,
`permissions.md`, `security.md`, `workflows.md`, `ui-ux.md`, `deployment.md`.

Rules that always apply:
- The owner commits and pushes. Never commit; end each finished step with a commit guide.
- No Co-Authored-By or Claude attribution lines.
- Never print or repeat secrets (`.env.local`, `scripts/dev-users.local.json`).
- Never modify HRestroSewa (the sibling RestroSewa repo).
- When a step is done, update "Resume here" in `memory-bank/current-task.md` and add decisions to
  `memory-bank/decisions.md`, so the next conversation can continue from them.
