// Suspends a vendor, or lifts the suspension. Only the control database changes: the vendor's own database is
// untouched.
//
//   node scripts/suspend-tenant.mjs <slug> [--reason "<why>"]             active -> suspended (local: the default)
//   node scripts/suspend-tenant.mjs <slug> --resume [--reason "<why>"]    suspended -> active
//   add --remote for venstock-dev-control (you run that, never Claude)
//
// A suspended vendor's site still opens (so they see the message and can download failed sales), but every API
// request answers 403 "This account is suspended". Suspending also ends any open support session on the vendor.
// Every change is recorded in audit_log. It takes effect within 45 seconds (the Worker's registry cache); no
// deploy is needed. Refuses unknown, provisioning and deleted vendors, and a vendor already in the asked-for state.
import { parseArgs, d1Target, die, stmt } from "./lib/d1-target.mjs";
import { suspendPlan, slugProblem, reasonProblem } from "./lib/tenant-status.mjs";

const USAGE = 'Usage: node scripts/suspend-tenant.mjs <slug> [--resume] [--reason "<why>"] [--remote]';
const { positional, flags, remote } = parseArgs(process.argv.slice(2), { usage: USAGE, allowed: ["--resume", "--reason"], withValue: ["--reason"] });
if (positional.length !== 1) die(USAGE);
const [slug] = positional;
const problem = slugProblem(slug) || reasonProblem(flags["--reason"]);
if (problem) die(`${problem}\n${USAGE}`);
const resume = !!flags["--resume"];

const t = d1Target({ remote });
if (!t.tableExists("CONTROL", "tenants")) die(`The control database isn't set up: run node scripts/migrate.mjs --control${remote ? " --remote" : ""} first.`);
const findRow = () => t.query("CONTROL", stmt("SELECT id, slug, name, status, status_changed_at FROM tenants WHERE slug = ?", slug))[0];

const row = findRow();
const plan = suspendPlan(row, { slug, resume, reason: flags["--reason"], now: new Date().toISOString() });
if (plan.error) die(plan.error);
t.run("CONTROL", ...plan.statements);
const after = findRow();
if (after.status !== plan.expect) die(`"${row.slug}" changed while this ran (now ${after.status}); nothing was recorded. Check and run again.`);

if (resume) {
  console.log(`\n"${row.name}" (${row.slug}, tenant ${row.id}) is active again. Recorded in the audit log.`);
  console.log("Their site and API work again within 45 seconds.\n");
} else {
  console.log(`\n"${row.name}" (${row.slug}, tenant ${row.id}) is suspended. Recorded in the audit log; any open support session ended.`);
  console.log("Within 45 seconds every API request answers \"This account is suspended\"; the site still opens.");
  console.log(`Lift it with: node scripts/suspend-tenant.mjs ${row.slug} --resume${remote ? " --remote" : ""}`);
  console.log(`Offboarding? Export their data now (docs/runbook.md), then: node scripts/delete-tenant.mjs ${row.slug} --confirm ${row.slug}${remote ? " --remote" : ""}\n`);
}
