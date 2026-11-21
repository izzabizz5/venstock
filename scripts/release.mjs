// Prepares a deploy. YOU run this; Claude never does, and this script never deploys or tags anything itself.
//
//   node scripts/release.mjs                          the real thing (venstock-dev-* databases)
//   node scripts/release.mjs --accept-removed a,b     allow fewer vendors than last time; must name exactly who is gone
//   node scripts/release.mjs --local [--skip-tests]   rehearsal against local databases (--skip-tests: local only)
//
// It:
//   1. checks migration checksums (nothing released at the latest release-* tag may have changed);
//   2. reads the registry and regenerates the wrangler config right before the deploy;
//   3. prints every vendor and the count, and warns about vendors stuck in "provisioning" (and for how long);
//   4. refuses if: an active vendor has no db_id; any active vendor or the control database is behind on migrations;
//      or there are fewer vendors than at the last release (unless --accept-removed names exactly the missing ones);
//   5. runs the test suite;
//   6. records this release's vendor list and prints the deploy command and the tag command for you to run.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, d1Target, die, ROOT } from "./lib/d1-target.mjs";
import { checkRepoMigrations, migrationFiles } from "./lib/manifest.mjs";
import { loadRegistry, behind, latestVendorMigration } from "./build-config.mjs";

const USAGE = "Usage: node scripts/release.mjs [--accept-removed slug,slug] [--local [--skip-tests] [--repo-root <dir>]]";
const { positional, flags } = parseArgs(process.argv.slice(2), {
  usage: USAGE, allowed: ["--accept-removed", "--skip-tests", "--repo-root", "--now"], withValue: ["--accept-removed", "--repo-root", "--now"],
});
if (positional.length) die(USAGE);
const remote = !flags["--local"]; // releases are remote unless explicitly rehearsed locally
for (const f of ["--skip-tests", "--repo-root", "--now"]) if (flags[f] && remote) die(`${f} is only allowed with --local (a rehearsal).`);
const now = flags["--now"] ? new Date(flags["--now"]) : new Date();

// 1. Migration checksums.
const repoRoot = flags["--repo-root"] || ROOT;
const { tag, problems } = checkRepoMigrations(repoRoot);
if (problems.length) die(`Refusing: migration checksum problems (vs ${tag ?? "no release tag"}):\n  ${problems.join("\n  ")}`);

// 2. Registry.
const t = d1Target({ remote });
const vendors = loadRegistry(t);
const bound = vendors.filter((v) => v.db_id);

// 3. The list, and stuck provisioning.
console.log(`\nVendors in this release: ${bound.length}`);
for (const v of vendors) console.log(`  ${v.db_id ? `DB_T${v.id}`.padEnd(8) : "(none)  "} ${v.slug.padEnd(24)} ${v.status.padEnd(13)} ${v.schema_version ?? "-"}`);
const hours = (iso) => Math.max(0, (now - new Date(iso)) / 3_600_000);
for (const v of vendors.filter((x) => x.status === "provisioning")) {
  const h = hours(v.status_changed_at);
  console.log(`WARNING: ${v.slug} (t${v.id}) has been provisioning for ${h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`}` +
    `${v.db_id ? "" : " and has no database yet"}. Finish it with: node scripts/create-tenant.mjs --resume ${v.slug}` +
    ` (or give up with --abandon ${v.slug}).`);
}

// 4. Refusals.
const refusals = [];
for (const v of vendors.filter((x) => x.status === "active" && !x.db_id)) refusals.push(`${v.slug} (t${v.id}) is active but has no db_id`);
for (const v of behind(vendors)) refusals.push(`${v.slug} (t${v.id}) is at ${v.schema_version ?? "nothing"}, latest is ${latestVendorMigration()}`);
const controlLatest = migrationFiles(join(ROOT, "migrations", "control")).at(-1);
const controlAt = t.appliedMigrations("CONTROL").at(-1);
if (controlAt !== controlLatest) refusals.push(`the control database is at ${controlAt ?? "nothing"}, latest is ${controlLatest}`);

const lastFile = join(dirname(t.generatedPath), "last-release.json");
const last = existsSync(lastFile) ? JSON.parse(readFileSync(lastFile, "utf8")) : null;
if (last && bound.length < last.count) {
  const missing = last.slugs.filter((s) => !bound.some((v) => v.slug === s)).sort();
  const accepted = (flags["--accept-removed"] || "").split(",").map((s) => s.trim()).filter(Boolean).sort();
  if (JSON.stringify(missing) !== JSON.stringify(accepted)) {
    refusals.push(`${bound.length} vendors, fewer than the ${last.count} at the last release (${last.date}). Missing: ` +
      `${missing.join(", ")}. If that is intended, re-run with --accept-removed ${missing.join(",")}`);
  }
}
if (refusals.length) die(`\nRefusing to prepare this release:\n  ${refusals.join("\n  ")}`);

// 5. Config, then the tests.
const configPath = t.writeConfig(vendors);
console.log(`\nWrote ${configPath}`);
if (flags["--skip-tests"]) console.log("Skipping the test suite (--skip-tests, local rehearsal only).");
else {
  console.log("Running the test suite...");
  const r = spawnSync("node", ["--test", "tests/**/*.test.mjs"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) die("Refusing: the test suite failed.");
}

// 6. Record and print what YOU run next. Nothing is deployed or tagged here.
const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim() || "HEAD";
writeFileSync(lastFile, JSON.stringify({ date: now.toISOString(), count: bound.length, slugs: bound.map((v) => v.slug), commit }, null, 2) + "\n");
const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
// Relative to the repo (where you run the deploy from); absolute if the config is outside it (local rehearsals).
const relToRoot = relative(ROOT, configPath);
const rel = relToRoot.startsWith("..") || isAbsolute(relToRoot) ? configPath : relToRoot;
console.log(`\nReady. Run these yourself${remote ? "" : " (this was a LOCAL rehearsal: don't deploy from it)"}:`);
console.log(`  npx wrangler deploy -c ${rel}`);
console.log("\nAfter the deploy succeeds, tag the release so its migration checksums become the new baseline:");
console.log(`  git tag release-${stamp} ${commit} && git push origin release-${stamp}\n`);
