// Soft-deletes a vendor: marks it deleted in the registry, ends any open support session, records it in audit_log
// and removes its binding from the generated config. That's all. It never drops a database and never removes the
// registry row, so the slug can never be used again. It prints the manual steps that remain: the export (which
// should already have happened), the release that disconnects the database, and the drop after the retention period.
//
//   node scripts/delete-tenant.mjs <slug> --confirm <slug> [--reason "<why>"]   (local: the default)
//   add --remote for venstock-dev-control (you run that, never Claude)
//
// Refuses unless the vendor is already suspended (node scripts/suspend-tenant.mjs <slug>) and --confirm repeats the
// exact slug. The vendor's address answers "Not found" within 45 seconds.
import { parseArgs, d1Target, die, stmt } from "./lib/d1-target.mjs";
import { deletePlan, slugProblem, reasonProblem } from "./lib/tenant-status.mjs";

const USAGE = 'Usage: node scripts/delete-tenant.mjs <slug> --confirm <slug> [--reason "<why>"] [--remote]';
const { positional, flags, remote } = parseArgs(process.argv.slice(2), { usage: USAGE, allowed: ["--confirm", "--reason"], withValue: ["--confirm", "--reason"] });
if (positional.length !== 1) die(USAGE);
const [slug] = positional;
const problem = slugProblem(slug) || reasonProblem(flags["--reason"]);
if (problem) die(`${problem}\n${USAGE}`);
if (flags["--confirm"] !== slug) die(`Refusing: pass --confirm ${slug} (the exact slug) to delete "${slug}".\n${USAGE}`);

const t = d1Target({ remote });
if (!t.tableExists("CONTROL", "tenants")) die(`The control database isn't set up: run node scripts/migrate.mjs --control${remote ? " --remote" : ""} first.`);
const registry = () => t.query("CONTROL", stmt("SELECT id, slug, name, status, db_binding, db_name, db_id FROM tenants WHERE status != 'deleted' ORDER BY id"));
const findRow = () => t.query("CONTROL", stmt("SELECT id, slug, name, status, status_changed_at, db_name, db_id FROM tenants WHERE slug = ?", slug))[0];

// Check every registered database (the remote name rule, in writeConfig) before writing anything.
t.writeConfig(registry());

const row = findRow();
const plan = deletePlan(row, { slug, confirm: flags["--confirm"], reason: flags["--reason"], now: new Date().toISOString() });
if (plan.error) die(plan.error);
t.run("CONTROL", ...plan.statements);
const after = findRow();
if (after.status !== plan.expect) die(`"${row.slug}" changed while this ran (now ${after.status}); nothing was recorded. Check and run again.`);
t.writeConfig(registry());

const r = remote ? " --remote" : "";
const day = new Date().toISOString().slice(0, 10);
console.log(`\n"${row.name}" (${row.slug}, tenant ${row.id}) is marked deleted. Recorded in the audit log.`);
console.log(`Its address answers "Not found" within 45 seconds. The slug "${row.slug}" can never be used again.`);
console.log("Nothing else was changed: its database still exists, with all its data.\n");
console.log("Remaining steps, by hand (docs/runbook.md, \"Deleting a vendor\"):");
if (!row.db_id) {
  console.log("  No database was ever recorded for this vendor, so there is nothing to export or drop.\n");
} else if (remote) {
  console.log(`  1. The export should already have been delivered. If not, take it now (it holds password hashes and`);
  console.log(`     authenticator secrets: strip the users and sessions rows before handing it over):`);
  console.log(`       npx wrangler d1 export ${row.db_name}${r} --output=${row.slug}-${day}.sql`);
  console.log(`  2. Disconnect the database with the next release:`);
  console.log(`       node scripts/release.mjs --accept-removed ${row.slug}`);
  console.log(`     then the deploy command it prints.`);
  console.log(`  3. After the agreed retention period, drop the database (permanent; Time Travel can't bring it back):`);
  console.log(`       npx wrangler d1 delete ${row.db_name}\n`);
} else {
  console.log(`  1. Restart wrangler dev to drop its binding.`);
  console.log(`  2. Its local database (${row.db_name}, id ${row.db_id}) is still in ${t.persistTo}; delete that data by hand if you want it gone.\n`);
}
