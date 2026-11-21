// Checks (default) or extends (--update) the migration checksum manifests in migrations/control and migrations/vendor.
//
//   node scripts/migrations-manifest.mjs            check: every file recorded and unchanged; nothing released changed
//   node scripts/migrations-manifest.mjs --update   record checksums for NEW migration files (never changes old ones)
import { join } from "node:path";
import { parseArgs, die, ROOT } from "./lib/d1-target.mjs";
import { KINDS, updateManifest, checkRepoMigrations } from "./lib/manifest.mjs";

const USAGE = "Usage: node scripts/migrations-manifest.mjs [--update]";
const { flags, positional } = parseArgs(process.argv.slice(2), { usage: USAGE, allowed: ["--update"] });
if (positional.length) die(USAGE);

if (flags["--update"]) {
  for (const kind of KINDS) {
    const { added, refused } = updateManifest(join(ROOT, "migrations", kind));
    if (refused.length) die(`migrations/${kind}: refusing to update:\n  ${refused.join("\n  ")}`);
    console.log(`migrations/${kind}: ${added.length ? `recorded ${added.join(", ")}` : "nothing new"}`);
  }
}
const { tag, problems } = checkRepoMigrations(ROOT);
if (problems.length) die(`Migration checksum problems:\n  ${problems.join("\n  ")}`);
console.log(`Migration checksums OK${tag ? ` (released entries unchanged since ${tag})` : " (no release-* tag yet, so nothing is recorded as released)"}.`);
