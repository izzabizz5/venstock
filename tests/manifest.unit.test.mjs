// Migration checksum manifests: the repo's own state, the rules, and the comparison with the latest release-* tag
// (tested against a real throwaway git repository).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRepoMigrations, compareToBaseline, verifyDir, updateManifest, latestReleaseBaseline, readManifest } from "../scripts/lib/manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the repo's migrations match their manifests and nothing released has changed", () => {
  const { tag, problems } = checkRepoMigrations(ROOT);
  assert.deepEqual(problems, [], `vs ${tag ?? "no release tag yet"}`);
});

test("compareToBaseline: released entries must stay identical; new entries are fine", () => {
  const released = { "0001_a.sql": "aaa", "0002_b.sql": "bbb" };
  assert.deepEqual(compareToBaseline({ ...released }, released), []);
  assert.deepEqual(compareToBaseline({ ...released, "0003_c.sql": "ccc" }, released), []);
  assert.equal(compareToBaseline({ ...released, "0002_b.sql": "XXX" }, released).length, 1);
  assert.equal(compareToBaseline({ "0001_a.sql": "aaa" }, released).length, 1, "removing a released entry is refused");
  assert.deepEqual(compareToBaseline({ "0001_a.sql": "anything" }, {}), [], "before the first release nothing is recorded");
});

test("verifyDir and updateManifest: unrecorded, changed, missing and badly named files", () => {
  const dir = mkdtempSync(join(tmpdir(), "venstock-manifest-"));
  try {
    writeFileSync(join(dir, "0001_first.sql"), "SELECT 1;\n");
    assert.match(verifyDir(dir)[0], /not in checksums\.json/);
    assert.deepEqual(updateManifest(dir), { added: ["0001_first.sql"], refused: [] });
    assert.deepEqual(verifyDir(dir), []);
    appendFileSync(join(dir, "0001_first.sql"), "SELECT 2;\n");
    assert.match(verifyDir(dir)[0], /changed since its checksum was recorded/);
    assert.equal(updateManifest(dir).refused.length, 1, "--update never rewrites an existing entry");
    rmSync(join(dir, "0001_first.sql"));
    assert.match(verifyDir(dir)[0], /file is missing/);
    writeFileSync(join(dir, "add stuff.sql"), "SELECT 1;\n");
    assert.ok(verifyDir(dir).some((p) => /name must look like/.test(p)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("latestReleaseBaseline: no tags means nothing is recorded; a tag without manifests records nothing", () => {
  const none = latestReleaseBaseline(ROOT, () => "");
  assert.deepEqual(none, { tag: null, manifests: { control: {}, vendor: {} } });
  const noFiles = latestReleaseBaseline(ROOT, (args) => {
    if (args[0] === "tag") return "release-2026-12-01\n";
    throw new Error("does not exist in that tag");
  });
  assert.deepEqual(noFiles, { tag: "release-2026-12-01", manifests: { control: {}, vendor: {} } });
});

test("against a real git repo: editing a migration released at the latest release-* tag is caught", () => {
  const repo = mkdtempSync(join(tmpdir(), "venstock-gitrepo-"));
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.test");
    git("config", "user.name", "test");
    for (const kind of ["control", "vendor"]) {
      mkdirSync(join(repo, "migrations", kind), { recursive: true });
      cpSync(join(ROOT, "migrations", kind), join(repo, "migrations", kind), { recursive: true });
    }
    git("add", "-A"); git("commit", "-q", "-m", "first");
    assert.deepEqual(checkRepoMigrations(repo).problems, [], "untagged: fine");

    git("tag", "release-2026-12-01");
    assert.equal(checkRepoMigrations(repo).tag, "release-2026-12-01");
    assert.deepEqual(checkRepoMigrations(repo).problems, []);

    // A new migration after the release: fine once recorded.
    writeFileSync(join(repo, "migrations", "vendor", "0002_new.sql"), "CREATE TABLE IF NOT EXISTS n (x INTEGER);\n");
    updateManifest(join(repo, "migrations", "vendor"));
    assert.deepEqual(checkRepoMigrations(repo).problems, []);

    // Editing a released file AND its manifest entry in the same change: still caught, via the tag.
    const vdir = join(repo, "migrations", "vendor");
    appendFileSync(join(vdir, "0001_baseline.sql"), "-- edited after release\n");
    const m = readManifest(vdir);
    m["0001_baseline.sql"] = "0".repeat(64);
    writeFileSync(join(vdir, "checksums.json"), JSON.stringify(m, null, 2));
    const { problems } = checkRepoMigrations(repo);
    assert.ok(problems.some((p) => /0001_baseline\.sql: was released, but its checksum changed/.test(p)), problems.join("\n"));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
