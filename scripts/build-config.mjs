// Writes the generated wrangler config (.wrangler-generated/<local|remote>/wrangler.toml) from the vendor registry:
// CONTROL plus one DB_T<id> binding per vendor database that exists (provisioning vendors included; the Worker
// answers 503 for any vendor that isn't active).
//
//   node scripts/build-config.mjs            local (then: npx wrangler dev -c .wrangler-generated/local/wrangler.toml
//                                            --persist-to .wrangler/state)
//   node scripts/build-config.mjs --remote   for a deploy; normally run through scripts/release.mjs (you, never Claude)
//
// Refuses while any active vendor's database is behind on migrations (run node scripts/migrate.mjs first), so code is
// never served against a database it doesn't expect.
import { join } from "node:path";
import { parseArgs, d1Target, die, stmt, ROOT } from "./lib/d1-target.mjs";
import { migrationFiles } from "./lib/manifest.mjs";

export function loadRegistry(t) {
  if (!t.tableExists("CONTROL", "tenants")) die("The control database has no tenants table: run node scripts/migrate.mjs --control first.");
  return t.query("CONTROL", stmt(`SELECT id, slug, name, status, db_name, db_id, schema_version, created_at, status_changed_at
    FROM tenants WHERE status != 'deleted' ORDER BY id`));
}

export const latestVendorMigration = () => migrationFiles(join(ROOT, "migrations", "vendor")).at(-1) || null;

// Active vendors whose database isn't at the latest vendor migration.
export function behind(vendors) {
  const latest = latestVendorMigration();
  return vendors.filter((v) => v.status === "active" && v.schema_version !== latest);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const USAGE = "Usage: node scripts/build-config.mjs [--remote]";
  const { positional, remote } = parseArgs(process.argv.slice(2), { usage: USAGE });
  if (positional.length) die(USAGE);
  const t = d1Target({ remote });
  const vendors = loadRegistry(t);
  const late = behind(vendors);
  if (late.length) {
    die(`Refusing: these active vendors are behind on migrations (latest is ${latestVendorMigration()}):\n` +
      late.map((v) => `  ${v.slug} (t${v.id}) at ${v.schema_version ?? "nothing"}`).join("\n") +
      `\nRun: node scripts/migrate.mjs${remote ? " --remote" : ""}`);
  }
  const path = t.writeConfig(vendors);
  const bound = vendors.filter((v) => v.db_id);
  console.log(`Wrote ${path}: ${bound.length} vendor database${bound.length === 1 ? "" : "s"}.`);
  for (const v of vendors) console.log(`  ${v.db_id ? `DB_T${v.id}`.padEnd(8) : "(none)  "} ${v.slug} (${v.status})`);
}
