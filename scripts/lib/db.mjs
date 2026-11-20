// Shared database access for CMediSewa tooling (migrations, posture checks, DB tests).
//
// Every target is an env file that DECLARES what it is (APP_ENV). The tools never infer
// "is this production?" from a hostname or a project ref — HRestroSewa learned that a
// copy-pasted PROD_REF constant goes stale and silently disarms the guard. Here the file
// says what it is, and the tool refuses anything it cannot classify.
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KNOWN = new Set(["development", "staging", "production"]);

/** Read and classify an env file. Throws instead of guessing. */
export function loadTarget(envFile = ".env.local") {
  const file = path.isAbsolute(envFile) ? envFile : path.join(ROOT, envFile);
  if (!fs.existsSync(file)) throw new Error(`${envFile} not found`);
  const env = parseEnv(fs.readFileSync(file, "utf8"));
  const appEnv = env.APP_ENV;
  if (!KNOWN.has(appEnv)) {
    throw new Error(`${envFile}: APP_ENV must be one of ${[...KNOWN].join(" | ")} (got ${appEnv ?? "nothing"})`);
  }
  if (!env.SUPABASE_DB_URL) throw new Error(`${envFile}: SUPABASE_DB_URL missing`);
  let host = "unknown";
  try { host = new URL(env.SUPABASE_DB_URL).hostname; } catch { /* reported by pg on connect */ }
  return { file: envFile, appEnv, host, env };
}

/**
 * Enforce the write interlocks:
 *   development → allowed
 *   staging     → needs --yes
 *   production  → needs --prod AND --yes
 * and --prod against a non-production file is refused (a mislabelled flag is a mistake too).
 */
export function assertWritable(target, { prod, yes }) {
  if (prod && target.appEnv !== "production") {
    throw new Error(`--prod given, but ${target.file} declares APP_ENV=${target.appEnv}`);
  }
  if (target.appEnv === "production" && !(prod && yes)) {
    throw new Error(`${target.file} is PRODUCTION: writing needs both --prod and --yes`);
  }
  if (target.appEnv === "staging" && !yes) {
    throw new Error(`${target.file} is STAGING: writing needs --yes`);
  }
}

export function client(target) {
  return new pg.Client({
    connectionString: target.env.SUPABASE_DB_URL,
    // Hosted Supabase and the self-hosted stack both terminate TLS; certificate pinning is
    // added with the production runbook (deployment.md). --no-ssl exists for SSH tunnels.
    // DB_SSL="false" in the env file (CI's plain Postgres container) or --no-ssl disables it.
    ssl: process.argv.includes("--no-ssl") || target.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });
}

/** Parse `--env <file>` and boolean flags from argv. */
export function parseArgs(argv = process.argv.slice(2)) {
  const envIdx = argv.indexOf("--env");
  const envFile = envIdx !== -1 ? argv[envIdx + 1] : ".env.local";
  if (envIdx !== -1 && !envFile) throw new Error("--env needs a file");
  const positional = argv.filter((a, i) => !a.startsWith("-") && !(envIdx !== -1 && i === envIdx + 1));
  return {
    cmd: positional[0] ?? "status",
    envFile,
    prod: argv.includes("--prod"),
    yes: argv.includes("--yes"),
  };
}
