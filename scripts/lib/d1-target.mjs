// Shared by every script in scripts/ that talks to D1. One rule for all of them:
//   - local by default (state in .wrangler/state, config in .wrangler-generated/local/);
//   - remote only with an explicit --remote, and then only databases named venstock-dev-control or
//     venstock-dev-t<id> (ALLOWED_REMOTE). Every remote call re-checks the database name behind the binding;
//   - always print which databases are about to be touched.
// Tests point local runs at throwaway folders with VENSTOCK_PERSIST_TO and VENSTOCK_GENERATED_DIR; both are ignored
// for remote runs.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomInt } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderConfig, readBaseToml, LOCAL_CONTROL, vendorBinding } from "./wrangler-config.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ALLOWED_REMOTE = /^venstock-dev-(control|t\d+)$/;

export function die(msg) {
  console.error(msg);
  process.exit(1);
}

// Splits argv into positional args and flags. Only `allowed` flags are accepted (plus --local/--remote);
// flags listed in `withValue` take the next argument as their value.
export function parseArgs(argv, { usage, allowed = [], withValue = [] } = {}) {
  const positional = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) { positional.push(a); continue; }
    if (a !== "--local" && a !== "--remote" && !allowed.includes(a)) die(`Unknown option ${a}.\n${usage}`);
    if (withValue.includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) die(`${a} needs a value.\n${usage}`);
      flags[a] = v;
    } else flags[a] = true;
  }
  if (flags["--local"] && flags["--remote"]) die("Pass --local or --remote, not both.");
  return { positional, flags, remote: !!flags["--remote"] };
}

// Decides local or remote once, prints it, and returns helpers. `migrationsRoot` (local only) lets tests use their
// own migration folders.
export function d1Target({ remote, migrationsRoot, quiet = false } = {}) {
  const base = readBaseToml(join(ROOT, "wrangler.toml"));
  let control, persistTo, outDir;
  if (remote) {
    if (migrationsRoot) die("Refusing: a custom migrations folder is only allowed for local runs.");
    const c = base.d1.find((b) => b.binding === "CONTROL");
    if (!c || !ALLOWED_REMOTE.test(c.database_name || "") || c.database_name !== "venstock-dev-control") {
      die(`Refusing --remote: wrangler.toml's CONTROL binding must name "venstock-dev-control" (found ${JSON.stringify(c?.database_name ?? null)}).`);
    }
    if (!c.database_id || c.database_id === "<>") die("Refusing --remote: set CONTROL's database_id in wrangler.toml (the id of venstock-dev-control).");
    control = { name: c.database_name, id: c.database_id };
    outDir = join(ROOT, ".wrangler-generated", "remote");
    if (!quiet) console.log("About to touch REMOTE D1 databases (only venstock-dev-control and venstock-dev-t<id>).");
  } else {
    control = LOCAL_CONTROL;
    persistTo = process.env.VENSTOCK_PERSIST_TO || join(ROOT, ".wrangler", "state");
    outDir = process.env.VENSTOCK_GENERATED_DIR || join(ROOT, ".wrangler-generated", "local");
    if (!quiet) console.log(`About to touch LOCAL D1 databases (state in ${persistTo}).`);
  }
  const configPath = join(outDir, "wrangler.toml");
  // database_name behind each binding in the config currently written (checked before every remote call).
  let names = { CONTROL: control.name };

  const where = remote ? ["--remote"] : ["--local", "--persist-to", persistTo];
  const checkBinding = (binding) => {
    if (!(binding in names)) throw new Error(`binding ${binding} is not in the generated config`);
    if (remote && !ALLOWED_REMOTE.test(names[binding])) die(`Refusing --remote: ${binding} is ${names[binding]}, which is not a venstock-dev-* database.`);
  };
  const wrangler = (args, { capture = true } = {}) =>
    spawnSync("npx", ["wrangler", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"] });

  const t = {
    remote, configPath, persistTo, control,
    // Writes the generated config with CONTROL plus these vendors (those with a db_id get a binding).
    writeConfig(vendors = []) {
      for (const v of vendors) if (v.db_id && remote && !ALLOWED_REMOTE.test(v.db_name)) die(`Refusing --remote: vendor ${v.id}'s database is ${v.db_name}, not venstock-dev-t<id>.`);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(configPath, renderConfig({ root: ROOT, outDir, control, vendors, migrationsRoot }));
      names = { CONTROL: control.name };
      for (const v of vendors) if (v.db_id) names[vendorBinding(v.id)] = v.db_name;
      return configPath;
    },
    // Runs SQL on one binding; throws with wrangler's error text on failure.
    run(binding, sql) {
      checkBinding(binding);
      const r = wrangler(["d1", "execute", binding, ...where, "-c", configPath, "--command", sql]);
      if (r.status !== 0) throw new Error(`d1 execute on ${binding} failed:\n${(r.stderr || r.stdout || "").trim()}`);
    },
    // One SELECT on one binding; returns its rows.
    query(binding, sql) {
      checkBinding(binding);
      const r = wrangler(["d1", "execute", binding, ...where, "-c", configPath, "--command", sql, "--json"]);
      if (r.status !== 0) throw new Error(`d1 query on ${binding} failed:\n${(r.stderr || r.stdout || "").trim()}`);
      return JSON.parse(r.stdout)[0].results;
    },
    tableExists(binding, table) {
      return t.query(binding, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${sqlString(table)}`).length > 0;
    },
    // Names of migrations wrangler has recorded as applied on this binding.
    appliedMigrations(binding) {
      return t.tableExists(binding, "d1_migrations") ? t.query(binding, "SELECT name FROM d1_migrations ORDER BY id").map((r) => r.name) : [];
    },
    // wrangler d1 migrations apply: each file is rolled back on error, and later files are not attempted.
    applyMigrations(binding) {
      checkBinding(binding);
      const r = wrangler(["d1", "migrations", "apply", binding, ...where, "-c", configPath, "--force"]);
      return { ok: r.status === 0, output: `${r.stdout || ""}${r.stderr || ""}`.trim() };
    },
    // Remote only: creates a database and returns its id. Name must be venstock-dev-t<id>.
    createDatabase(name) {
      if (!remote) throw new Error("createDatabase is remote only (local databases appear on first use)");
      if (!ALLOWED_REMOTE.test(name) || name === "venstock-dev-control") die(`Refusing to create ${name}: only venstock-dev-t<id>.`);
      const r = wrangler(["d1", "create", name]);
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      const id = out.match(/"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"/i)?.[1];
      if (r.status !== 0 || !id) throw new Error(`wrangler d1 create ${name} failed or printed no database_id:\n${out.trim()}`);
      return id;
    },
  };
  return t;
}

// SQL string literal (the wrangler CLI can't bind parameters, so every value goes through this).
export const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

export const EMAIL = /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/;

// A one-time invite code. Must match newInvite() / normalizeInvite() in src/lib/auth.js.
export function newInvite(days = 7) {
  const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const code = Array.from({ length: 12 }, () => CHARS[randomInt(CHARS.length)]).join("");
  return {
    pretty: code.match(/.{4}/g).join("-"),
    hash: createHash("sha256").update(code).digest("base64url"),
    expires: Date.now() + days * 24 * 60 * 60 * 1000,
  };
}

