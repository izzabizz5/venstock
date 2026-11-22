// Shared by every script in scripts/ that talks to D1. One rule for all of them:
//   - local by default (state in .wrangler/state, config in .wrangler-generated/local/);
//   - remote only with an explicit --remote, and then only databases named venstock-dev-control or
//     venstock-dev-t<id> (ALLOWED_REMOTE). Every remote call re-checks the database name behind the binding;
//   - always print which databases are about to be touched.
// Tests point local runs at throwaway folders with VENSTOCK_PERSIST_TO and VENSTOCK_GENERATED_DIR; both are ignored
// for remote runs.
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomInt } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderConfig, readBaseToml, productionDomainProblem, LOCAL_CONTROL, vendorBinding } from "./wrangler-config.mjs";
import { stmt, isStmt, localExecutor, remoteExecutor } from "./executor.mjs";
export { stmt };

// Set only by tests, from inside the process: see d1Target().
export const TEST_EXECUTOR = Symbol.for("venstock.test.executor");

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
    const domain = productionDomainProblem(base);
    if (domain) die(`Refusing --remote: ${domain}`);
    control = { name: c.database_name, id: c.database_id };
    outDir = join(ROOT, ".wrangler-generated", "remote");
    if (!quiet) console.log("About to touch REMOTE D1 databases (only venstock-dev-control and venstock-dev-t<id>).");
  } else {
    control = LOCAL_CONTROL;
    persistTo = process.env.VENSTOCK_PERSIST_TO || join(ROOT, ".wrangler", "state");
    outDir = process.env.VENSTOCK_GENERATED_DIR || join(ROOT, ".wrangler-generated", "local");
    if (!quiet) console.log(`About to touch LOCAL D1 databases (state in ${persistTo}).`);
  }
  // The shared generated config (what local dev and deploys use) is only ever written with the FULL vendor list, by
  // writeConfig(). Until then, commands run against a private control-only config in a temp folder, so a script that
  // only reads the registry, or stops early, can never leave the shared file without its vendor bindings.
  const generatedPath = join(outDir, "wrangler.toml");
  const bootstrapDir = mkdtempSync(join(tmpdir(), "venstock-bootstrap-"));
  process.on("exit", () => rmSync(bootstrapDir, { recursive: true, force: true }));
  let configPath = join(bootstrapDir, "wrangler.toml");
  const target = remote ? "remote" : "local";
  writeFileSync(configPath, renderConfig({ root: ROOT, outDir: bootstrapDir, control, vendors: [], migrationsRoot, target }));
  // database_name (checked before every remote call) and database_id (local file) behind each binding in the
  // config currently in use.
  let names = { CONTROL: control.name };
  let ids = { CONTROL: control.id };

  // The executor does the I/O; every check stays here, before it. The remote executor is built only when `remote`
  // is true, and `remote` only ever comes from an explicit --remote (parseArgs). A test may substitute both executors
  // with a recording one by setting TEST_EXECUTOR from inside the process (node --import); nothing outside the
  // process (no env var, no flag) can.
  const fake = globalThis[TEST_EXECUTOR];
  const exec = fake ? fake({ mode: remote ? "remote" : "local", persistTo, root: ROOT })
    : remote ? remoteExecutor() : localExecutor({ persistTo });
  if (exec.mode !== (remote ? "remote" : "local")) throw new Error("executor mode doesn't match the target");
  const checkBinding = (binding) => {
    if (!(binding in names)) throw new Error(`binding ${binding} is not in the generated config`);
    if (remote && !ALLOWED_REMOTE.test(names[binding])) die(`Refusing --remote: ${binding} is ${names[binding]}, which is not a venstock-dev-* database.`);
    return { binding, databaseId: ids[binding], databaseName: names[binding], configPath, root: ROOT };
  };
  const asStmt = (s) => {
    if (!isStmt(s)) throw new Error("scripts pass statements built with stmt(sql, ...params), never raw SQL strings");
    return s;
  };

  const t = {
    remote, generatedPath, persistTo, control,
    get configPath() { return configPath; },
    // Writes the shared generated config with CONTROL plus these vendors (those with a db_id get a binding).
    // Callers pass every non-deleted vendor in the registry, never a subset.
    writeConfig(vendors) {
      if (!Array.isArray(vendors)) throw new Error("writeConfig needs the full vendor list");
      for (const v of vendors) if (v.db_id && remote && !ALLOWED_REMOTE.test(v.db_name)) die(`Refusing --remote: vendor ${v.id}'s database is ${v.db_name}, not venstock-dev-t<id>.`);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(generatedPath, renderConfig({ root: ROOT, outDir, control, vendors, migrationsRoot, target }));
      configPath = generatedPath;
      names = { CONTROL: control.name };
      ids = { CONTROL: control.id };
      for (const v of vendors) if (v.db_id) { names[vendorBinding(v.id)] = v.db_name; ids[vendorBinding(v.id)] = v.db_id; }
      return generatedPath;
    },
    // Reads every non-deleted vendor from the registry and writes the shared config for all of them.
    refreshConfig() {
      if (!t.tableExists("CONTROL", "tenants")) return null;
      const vendors = t.query("CONTROL", stmt(`SELECT id, slug, name, status, db_name, db_id, schema_version, owner_email, created_at, status_changed_at
        FROM tenants WHERE status != 'deleted' ORDER BY id`));
      t.writeConfig(vendors);
      return vendors;
    },
    // Runs one or more statements on one binding, all or nothing; throws with the database's error text.
    run(binding, ...stmts) {
      const ctx = checkBinding(binding);
      if (!stmts.length) throw new Error("run: no statements");
      stmts.forEach(asStmt);
      try { exec.run(stmts, ctx); }
      catch (e) { throw new Error(`d1 execute on ${binding} failed:\n${e.message}`); }
    },
    // One SELECT on one binding; returns its rows.
    query(binding, s) {
      const ctx = checkBinding(binding);
      try { return exec.query(asStmt(s), ctx); }
      catch (e) { throw new Error(`d1 query on ${binding} failed:\n${e.message}`); }
    },
    tableExists(binding, table) {
      return t.query(binding, stmt("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table)).length > 0;
    },
    // Names of migrations wrangler has recorded as applied on this binding.
    appliedMigrations(binding) {
      return t.tableExists(binding, "d1_migrations") ? t.query(binding, stmt("SELECT name FROM d1_migrations ORDER BY id")).map((r) => r.name) : [];
    },
    // wrangler d1 migrations apply: each file is rolled back on error, and later files are not attempted.
    applyMigrations(binding) {
      return exec.applyMigrations(checkBinding(binding));
    },
    // Remote only: creates a database and returns its id. Name must be venstock-dev-t<id>.
    createDatabase(name) {
      if (!remote) throw new Error("createDatabase is remote only (local databases appear on first use)");
      if (!ALLOWED_REMOTE.test(name) || name === "venstock-dev-control") die(`Refusing to create ${name}: only venstock-dev-t<id>.`);
      return exec.createDatabase(name, { root: ROOT });
    },
  };
  return t;
}


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

