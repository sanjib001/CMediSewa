#!/usr/bin/env node
/**
 * CMediSewa migration runner (adapted from HRestroSewa's scripts/migrate.mjs).
 *
 *   node scripts/migrate.mjs status                 what is applied (default target .env.local)
 *   node scripts/migrate.mjs up                     apply pending migrations
 *   node scripts/migrate.mjs up --env .env.staging --yes
 *   node scripts/migrate.mjs up --env .env.prod --prod --yes
 *   node scripts/migrate.mjs reset --yes            DEVELOPMENT ONLY: drop everything the
 *                                                   migrations created, so `up` replays
 *                                                   from an empty schema (replay check)
 *
 * Rules (same as HRestroSewa, which earned them in production):
 *   1. Each migration runs in ONE transaction together with its ledger row, so "applied"
 *      and "recorded" can never disagree.
 *   2. The first failure stops the run.
 *   3. Migrations are additive; there are no down-migrations. Fix forward.
 *   4. The ledger is `supabase_migrations.schema_migrations`, the table the Supabase CLI
 *      uses, so both tools agree on what ran.
 * Differences from HRestroSewa:
 *   - targets classify themselves with APP_ENV (scripts/lib/db.mjs), not by hostname;
 *   - there is no HTTP-through-Kong mode: CMediSewa blocks Kong /pg publicly (D-15), so
 *     production is reached through an SSH tunnel (--no-ssl when the tunnel is plain).
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadTarget, assertWritable, client, parseArgs } from "./lib/db.mjs";

const DIR = path.join(ROOT, "supabase", "migrations");
const args = parseArgs();

const files = () =>
  fs.readdirSync(DIR).filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f)).sort().map((f) => ({
    file: f,
    version: f.slice(0, 14),
    name: f.slice(15, -4),
  }));

async function ensureLedger(c) {
  await c.query(`create schema if not exists supabase_migrations`);
  await c.query(`create table if not exists supabase_migrations.schema_migrations (
    version text primary key, statements text[], name text)`);
}

async function main() {
  const target = loadTarget(args.envFile);
  const c = client(target);
  await c.connect();
  try {
    await ensureLedger(c);
    const all = files();
    const done = new Set((await c.query(`select version from supabase_migrations.schema_migrations`)).rows.map((r) => r.version));
    const pending = all.filter((m) => !done.has(m.version));
    console.log(`target: ${target.appEnv.toUpperCase()} (${target.file}, ${target.host})`);
    console.log(`on disk: ${all.length}   applied: ${all.length - pending.length}   pending: ${pending.length}`);

    if (args.cmd === "status") {
      for (const m of pending) console.log(`  PENDING  ${m.file}`);
      const orphans = [...done].filter((v) => !all.some((m) => m.version === v));
      if (orphans.length) console.log(`  ledger rows with no file: ${orphans.join(", ")}`);
      if (!pending.length) console.log("  up to date");
      return;
    }

    if (args.cmd === "up") {
      assertWritable(target, args);
      for (const m of pending) {
        const sql = fs.readFileSync(path.join(DIR, m.file), "utf8");
        process.stdout.write(`  ${m.file.padEnd(60)} `);
        try {
          await c.query("begin");
          await c.query(sql);
          await c.query(
            `insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)`,
            [m.version, m.name, [sql]]
          );
          await c.query("commit");
          console.log("ok");
        } catch (e) {
          await c.query("rollback").catch(() => {});
          console.log("FAILED");
          throw new Error(`${m.file}: ${e.code ?? ""} ${e.message}`);
        }
      }
      if (!pending.length) console.log("  nothing to do");
      return;
    }

    if (args.cmd === "reset") {
      if (target.appEnv !== "development") throw new Error("reset is allowed on DEVELOPMENT targets only");
      if (!args.yes) throw new Error("reset drops every CMediSewa object in the dev database: re-run with --yes");
      // Everything our migrations create is owned by the migrating role in `public`, plus
      // the app roles. Supabase-managed schemas (auth, storage, extensions…) are untouched.
      await c.query(`do $$
        declare r record;
        begin
          for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relkind in ('r','p','v','m') and pg_get_userbyid(c.relowner) in (current_user, 'ledger_writer')
          loop execute format('drop table if exists public.%I cascade', r.relname); end loop;
          for r in select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and pg_get_userbyid(p.proowner) in (current_user, 'ledger_writer')
          loop execute 'drop function if exists ' || r.sig || ' cascade'; end loop;
          for r in select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
                   where n.nspname = 'public' and t.typtype in ('e','d') and pg_get_userbyid(t.typowner) = current_user
          loop execute format('drop type if exists public.%I cascade', r.typname); end loop;
          if exists (select 1 from pg_roles where rolname = 'ledger_writer') then
            execute 'drop owned by ledger_writer cascade';
            execute 'drop role ledger_writer';
          end if;
        end $$`);
      await c.query(`delete from supabase_migrations.schema_migrations`);
      console.log("  dev database reset: run `up` to replay every migration from empty");
      return;
    }

    throw new Error(`unknown command ${args.cmd} (status | up | reset)`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
