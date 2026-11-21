// Migration checksum manifests: migrations/<kind>/checksums.json maps each migration file to its SHA-256.
// Rules (enforced by scripts/migrate.mjs, scripts/release.mjs and tests/manifest.unit.test.mjs):
//   - every migration file on disk is in the manifest, with a matching checksum;
//   - entries recorded at the latest release-* git tag never change (only new entries may be added);
//   - before the first release tag there are no recorded entries.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const KINDS = ["control", "vendor"];
export const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function migrationFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
}
export function readManifest(dir) {
  const p = join(dir, "checksums.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

// Problems with a directory against its own manifest (empty array = fine).
export function verifyDir(dir) {
  const problems = [];
  const manifest = readManifest(dir);
  const files = migrationFiles(dir);
  for (const f of files) {
    if (!MIGRATION_NAME.test(f)) problems.push(`${f}: name must look like 0001_description.sql`);
    else if (!(f in manifest)) problems.push(`${f}: not in checksums.json (run: node scripts/migrations-manifest.mjs --update)`);
    else if (manifest[f] !== sha256(join(dir, f))) problems.push(`${f}: changed since its checksum was recorded`);
  }
  for (const f of Object.keys(manifest)) if (!files.includes(f)) problems.push(`${f}: in checksums.json but the file is missing`);
  return problems;
}

// Problems comparing the current manifest with the one recorded at the latest release (empty = fine).
export function compareToBaseline(current, baseline) {
  const problems = [];
  for (const [f, sum] of Object.entries(baseline)) {
    if (!(f in current)) problems.push(`${f}: was released, but is gone from checksums.json`);
    else if (current[f] !== sum) problems.push(`${f}: was released, but its checksum changed (released migrations must never change)`);
  }
  return problems;
}

// The newest release-* tag and the manifests recorded in it. `git` can be swapped in tests.
export function latestReleaseBaseline(root, git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) {
  let tag = null;
  try { tag = git(["tag", "--list", "release-*", "--sort=-creatordate"]).split("\n").map((s) => s.trim()).find(Boolean) || null; } catch {}
  const manifests = {};
  for (const kind of KINDS) {
    manifests[kind] = {};
    if (!tag) continue;
    try { manifests[kind] = JSON.parse(git(["show", `${tag}:migrations/${kind}/checksums.json`])); } catch {}
  }
  return { tag, manifests };
}

// All problems for the repo's migrations: each directory against its manifest, and each manifest against the
// latest release tag.
export function checkRepoMigrations(root, git) {
  const { tag, manifests } = latestReleaseBaseline(root, git);
  const problems = [];
  for (const kind of KINDS) {
    const dir = join(root, "migrations", kind);
    for (const p of verifyDir(dir)) problems.push(`migrations/${kind}/${p}`);
    for (const p of compareToBaseline(readManifest(dir), manifests[kind])) problems.push(`migrations/${kind}/${p} (vs ${tag})`);
  }
  return { tag, problems };
}

// Adds entries for new files only. Never changes an existing entry.
export function updateManifest(dir) {
  const manifest = readManifest(dir);
  const added = [], refused = [];
  for (const f of migrationFiles(dir)) {
    if (!MIGRATION_NAME.test(f)) { refused.push(`${f}: bad name`); continue; }
    const sum = sha256(join(dir, f));
    if (!(f in manifest)) { manifest[f] = sum; added.push(f); } else if (manifest[f] !== sum) refused.push(`${f}: already recorded with a different checksum`);
  }
  if (!refused.length) {
    const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
    writeFileSync(join(dir, "checksums.json"), JSON.stringify(sorted, null, 2) + "\n");
  }
  return { added, refused };
}
