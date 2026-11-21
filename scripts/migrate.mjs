// Applies pending migrations to the control database and every vendor database, in order, and reports per database.
//
//   node scripts/migrate.mjs                     control, then every vendor (local: the default)
//   node scripts/migrate.mjs --control           control only
//   node scripts/migrate.mjs --vendors           every vendor (control must already be up to date)
//   node scripts/migrate.mjs --tenant <slug>     one vendor
//   add --remote to run against venstock-dev-* databases (you run that, never Claude)
//
// MIGRATIONS MUST BE BACKWARD COMPATIBLE. Between "migrate" and "deploy", the currently deployed code runs against
// the new schema. Add first (new tables, new nullable columns, new indexes); remove or rename only in a later release,
// after the code that stopped using the old shape is live. Never edit a released migration: add a new one.
//
// How it applies: `wrangler d1 migrations apply <binding> --force` per database. Wrangler rolls back a file that
// fails and does not attempt later files. This runner stops at the first database that fails, prints which
// databases are done / failed / not started, and records each vendor's latest migration in tenants.schema_version.
// Re-running resumes: applied files are skipped by wrangler (its d1_migrations table).
import { join } from "node:path";
import { parseArgs, d1Target, die, sqlString, ROOT } from "./lib/d1-target.mjs";
import { verifyDir, checkRepoMigrations, migrationFiles } from "./lib/manifest.mjs";
import { vendorBinding } from "./lib/wrangler-config.mjs";

const USAGE = "Usage: node scripts/migrate.mjs [--control | --vendors | --tenant <slug>] [--remote]";

export function main(argv) {
  const { flags, positional, remote } = parseArgs(argv, {
    usage: USAGE, allowed: ["--control", "--vendors", "--tenant", "--migrations-root"], withValue: ["--tenant", "--migrations-root"],
  });
  if (positional.length) die(USAGE);
  const scopes = ["--control", "--vendors", "--tenant"].filter((f) => flags[f]);
  if (scopes.length > 1) die(`Pick one of --control, --vendors, --tenant.\n${USAGE}`);
  const doControl = !flags["--vendors"] && !flags["--tenant"];
  const doVendors = !flags["--control"];
  const migrationsRoot = flags["--migrations-root"];

  // 1. Migration files must match their checksum manifests (and, for the repo's own migrations, the latest release).
  const problems = migrationsRoot
    ? ["control", "vendor"].flatMap((k) => verifyDir(join(migrationsRoot, k)).map((p) => `${k}/${p}`))
    : checkRepoMigrations(ROOT).problems;
  if (problems.length) die(`Refusing to migrate; migration files don't match their checksums:\n  ${problems.join("\n  ")}`);
  const root = migrationsRoot || join(ROOT, "migrations");
  const latestVendor = migrationFiles(join(root, "vendor")).at(-1) || null;

  const t = d1Target({ remote, migrationsRoot });
  const report = [];
  const finish = (failed) => {
    console.log("\nDatabase              Result        Applied this run");
    for (const r of report) console.log(`${r.db.padEnd(21)} ${r.result.padEnd(13)} ${r.applied.join(", ") || "-"}`);
    if (failed) {
      console.log(`\nStopped at ${failed.db}. Fix the cause, then run the same command again: databases marked "done" are skipped.\n`);
      console.log(failed.output);
    }
    return failed ? 1 : 0;
  };
  const applyTo = (binding, label) => {
    const before = t.appliedMigrations(binding);
    const res = t.applyMigrations(binding);
    const after = t.appliedMigrations(binding);
    const applied = after.filter((m) => !before.includes(m));
    if (!res.ok) {
      const entry = { db: label, result: "FAILED", applied, output: res.output };
      report.push(entry);
      return { ok: false, entry, after };
    }
    report.push({ db: label, result: applied.length ? "done" : "up to date", applied });
    return { ok: true, after };
  };

  // 2. Control first: the registry lives there.
  t.writeConfig([]);
  if (doControl) {
    const r = applyTo("CONTROL", "control");
    if (!r.ok) return finish(r.entry);
  }
  if (!doVendors) return finish(null);

  // 3. Vendors in id order. Provisioning vendors are included (create-tenant runs this before marking them active).
  if (!t.tableExists("CONTROL", "tenants")) die("The control database has no tenants table yet: run node scripts/migrate.mjs --control first.");
  // The generated config always lists every registered vendor (it is the same file local dev and deploys use),
  // even when only one vendor is being migrated.
  const all = t.query("CONTROL", "SELECT id, slug, status, db_name, db_id FROM tenants WHERE status != 'deleted' ORDER BY id");
  t.writeConfig(all);
  const slug = flags["--tenant"];
  const vendors = slug ? all.filter((v) => v.slug.toLowerCase() === slug.toLowerCase()) : all;
  if (slug && !vendors.length) die(`No vendor with the slug "${slug}" (or it was abandoned).`);
  const todo = vendors.filter((v) => v.db_id);
  for (const v of vendors.filter((v) => !v.db_id)) report.push({ db: `${v.slug} (t${v.id})`, result: "no database", applied: [] });

  for (const [i, v] of todo.entries()) {
    const label = `${v.slug} (t${v.id})`;
    const r = applyTo(vendorBinding(v.id), label);
    if (!r.ok) {
      for (const rest of todo.slice(i + 1)) report.push({ db: `${rest.slug} (t${rest.id})`, result: "not started", applied: [] });
      return finish(r.entry);
    }
    const version = r.after.at(-1) || null;
    t.run("CONTROL", `UPDATE tenants SET schema_version = ${version ? sqlString(version) : "NULL"} WHERE id = ${v.id}`);
    if (version !== latestVendor) {
      report.at(-1).result = "BEHIND";
      return finish({ db: label, output: `${label} is at ${version}, expected ${latestVendor}.` });
    }
  }
  return finish(null);
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
