// Fast checks on the scripts' guards and argument handling: everything here is refused before any database is
// touched, so nothing starts wrangler. Part of test:fast. (Moved unchanged from scripts/migrate/release tests.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync, chmodSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-11-21T12:00:00Z";
let dir, env;

function script(name, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", name), ...args], { cwd: ROOT, encoding: "utf8", env: { ...env, ...extraEnv } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const node = script;
const release = (...args) => node("release.mjs", ["--local", "--skip-tests", "--now", NOW, ...args]);

// Throwaway local folders, in case a guard ever failed to stop a script early.
before(() => {
  dir = mkdtempSync(join(tmpdir(), "venstock-guard-"));
  env = { ...process.env, VENSTOCK_PERSIST_TO: join(dir, "state"), VENSTOCK_GENERATED_DIR: join(dir, "gen") };
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("unknown options and --local with --remote are refused", () => {
  assert.notEqual(script("create-tenant.mjs", ["zzz-shop", "Z", "z@example.test", "--remte"]).code, 0);
  assert.notEqual(script("add-admin.mjs", ["--tenant", "acme", "z@example.test", "--local", "--remote"]).code, 0);
  assert.notEqual(script("create-tenant.mjs", ["--resume", "a", "--abandon", "b"]).code, 0);
  assert.notEqual(script("suspend-tenant.mjs", ["acme", "--resum"]).code, 0);
  assert.notEqual(script("delete-tenant.mjs", ["acme", "--confirm", "acme", "--force"]).code, 0);
});

test("suspend-tenant and delete-tenant refuse bad arguments before opening any database", () => {
  for (const [name, args, why] of [
    ["suspend-tenant.mjs", [], /Usage: node scripts\/suspend-tenant\.mjs/],
    ["suspend-tenant.mjs", ["acme", "demo"], /Usage/],
    ["suspend-tenant.mjs", ["Acme"], /Bad slug "Acme"/],
    ["suspend-tenant.mjs", ["acme", "--reason", "a\u0007b"], /1-200 characters/],
    ["delete-tenant.mjs", ["acme"], /pass --confirm acme \(the exact slug\)/],
    ["delete-tenant.mjs", ["acme", "--confirm"], /--confirm needs a value/],
    ["delete-tenant.mjs", ["acme", "--confirm", "demo"], /pass --confirm acme/],
    ["delete-tenant.mjs", ["acme", "--confirm", "ACME"], /pass --confirm acme/],
    ["delete-tenant.mjs", ["acme", "--confirm", "acme", "--remote", "--local"], /not both/],
  ]) {
    const r = script(name, args);
    assert.equal(r.code, 1, `${name} ${args.join(" ")}`);
    assert.match(r.out, why, `${name} ${args.join(" ")}`);
    assert.doesNotMatch(r.out, /About to touch/, "refused before choosing a database");
  }
  assert.ok(!existsSync(join(dir, "state")), "no local database was created");
});

test("--remote is refused while wrangler.toml's CONTROL id is a placeholder", () => {
  for (const [name, args] of [["create-tenant.mjs", ["zzz-shop", "Z", "z@example.test"]], ["add-admin.mjs", ["--tenant", "acme", "z@example.test"]],
    ["create-platform-admin.mjs", ["z@example.test"]], ["migrate.mjs", []], ["build-config.mjs", []],
    ["suspend-tenant.mjs", ["acme"]], ["suspend-tenant.mjs", ["acme", "--resume"]], ["delete-tenant.mjs", ["acme", "--confirm", "acme"]]]) {
    const r = script(name, [...args, "--remote"]);
    assert.notEqual(r.code, 0, name);
    assert.match(r.out, /set CONTROL's database_id/, name);
  }
});

test("--remote is refused until BASE_DOMAIN is the real vendor domain with a wildcard route (a localhost deploy would 404)", () => {
  const copy = mkdtempSync(join(tmpdir(), "venstock-domain-"));
  try {
    for (const p of ["scripts", "src", "migrations", "public"]) cpSync(join(ROOT, p), join(copy, p), { recursive: true });
    const withId = readFileSync(join(ROOT, "wrangler.toml"), "utf8")
      .replace(/(binding = "CONTROL"\ndatabase_name = "venstock-dev-control"\ndatabase_id = )"<>"/, '$1"11111111-2222-3333-4444-555555555555"');
    mkdirSync(join(copy, "bin"));
    const npxLog = join(copy, "npx.log");
    writeFileSync(join(copy, "bin", "npx"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${npxLog}"\nexit 97\n`);
    chmodSync(join(copy, "bin", "npx"), 0o755);
    const renv = { ...process.env, PATH: `${join(copy, "bin")}:${process.env.PATH}` };
    const run = (name, args) => spawnSync(process.execPath, [join(copy, "scripts", name), ...args, "--remote"], { cwd: copy, encoding: "utf8", env: renv });
    for (const [toml, why] of [[withId, /set BASE_DOMAIN/],
      [withId.replace('BASE_DOMAIN = "localhost"', 'BASE_DOMAIN = "shops.example"'), /add a \[\[routes\]\] block/]]) {
      writeFileSync(join(copy, "wrangler.toml"), toml);
      for (const [name, args] of [["build-config.mjs", []], ["migrate.mjs", []], ["create-platform-admin.mjs", ["z@example.test"]],
        ["create-tenant.mjs", ["zzz-shop", "Z", "z@example.test"]], ["release.mjs", []],
        ["suspend-tenant.mjs", ["zzz-shop"]], ["delete-tenant.mjs", ["zzz-shop", "--confirm", "zzz-shop"]]]) {
        const r = run(name, args);
        assert.notEqual(r.status, 0, name);
        assert.match(`${r.stdout}${r.stderr}`, why, name);
      }
    }
    assert.ok(!existsSync(npxLog) || readFileSync(npxLog, "utf8") === "", "nothing was sent anywhere");
  } finally { rmSync(copy, { recursive: true, force: true }); }
});

test("remote, against a copy with a real-looking control id and a fake npx: only venstock-dev-* is ever touched", () => {
  const copy = mkdtempSync(join(tmpdir(), "venstock-remote-"));
  try {
    for (const p of ["scripts", "src", "migrations", "public"]) cpSync(join(ROOT, p), join(copy, p), { recursive: true });
    writeFileSync(join(copy, "wrangler.toml"), readFileSync(join(ROOT, "wrangler.toml"), "utf8")
      .replace(/BASE_DOMAIN = "localhost"/, 'BASE_DOMAIN = "shops.example"\n\n[[routes]]\npattern = "*.shops.example/*"\nzone_name = "shops.example"')
      .replace(/(binding = "CONTROL"\ndatabase_name = "venstock-dev-control"\ndatabase_id = )"<>"/, '$1"11111111-2222-3333-4444-555555555555"'));
    mkdirSync(join(copy, "bin"));
    const log = join(copy, "npx.log");
    const cfgLog = join(copy, "configs.log");
    // Records each call and a copy of the config it was given (temporary configs are deleted when the script exits).
    // Pretends the control database exists and is empty; prints a database_id for `d1 create`.
    writeFileSync(join(copy, "bin", "npx"), `#!/bin/sh
printf '%s\\n' "$(echo "$*" | tr '\\n' ' ')" >> "${log}"
prev=""; for a in "$@"; do [ "$prev" = "-c" ] && cat "$a" >> "${cfgLog}"; prev="$a"; done
case "$*" in
  *"d1 create"*) echo 'database_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"';;
  *sqlite_master*) echo '[{"results":[{"name":"tenants"}]}]';;
  *--json*) echo '[{"results":[]}]';;
esac
`);
    chmodSync(join(copy, "bin", "npx"), 0o755);
    const renv = { ...process.env, PATH: `${join(copy, "bin")}:${process.env.PATH}`, VENSTOCK_PERSIST_TO: "/never/used", VENSTOCK_GENERATED_DIR: "/never/used" };
    const r = spawnSync(process.execPath, [join(copy, "scripts", "create-platform-admin.mjs"), "z@example.test", "--remote"], { cwd: copy, encoding: "utf8", env: renv });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /About to touch REMOTE D1 databases/);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    for (const c of calls) {
      assert.match(c, /^wrangler d1 execute CONTROL --remote -c \S+wrangler\.toml /, c);
      assert.doesNotMatch(c, /--local|--persist-to|\/never\/used/);
    }
    const names = [...readFileSync(cfgLog, "utf8").matchAll(/database_name = "([^"]+)"/g)].map((m) => m[1]);
    assert.ok(names.length >= calls.length);
    for (const n of names) assert.match(n, /^venstock-dev-(control|t\d+)$/);
    assert.ok(!existsSync(join(copy, ".wrangler-generated", "remote", "wrangler.toml")), "a staff-only script never rewrites the shared config");

    // A vendor database name outside the rule is refused before anything runs against it.
    const guard = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { d1Target } from ${JSON.stringify(join(copy, "scripts", "lib", "d1-target.mjs"))};
       const t = d1Target({ remote: true, quiet: true });
       t.writeConfig([{ id: 7, db_name: "show-pos-db", db_id: "x" }]);`], { cwd: copy, encoding: "utf8", env: renv });
    assert.notEqual(guard.status, 0);
    assert.match(guard.stderr, /not venstock-dev-t<id>/);
  } finally { rmSync(copy, { recursive: true, force: true }); }
});

test("a new migration file that isn't in checksums.json: refused", () => {
  const fresh = mkdtempSync(join(tmpdir(), "venstock-migs-"));
  try {
    cpSync(join(ROOT, "migrations", "control"), join(fresh, "control"), { recursive: true });
    cpSync(join(ROOT, "migrations", "vendor"), join(fresh, "vendor"), { recursive: true });
    writeFileSync(join(fresh, "vendor", "0002_unrecorded.sql"), "SELECT 1;\n");
    const r = spawnSync("node", [join(ROOT, "scripts", "migrate.mjs"), "--migrations-root", fresh], { cwd: ROOT, encoding: "utf8", env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /0002_unrecorded\.sql: not in checksums\.json/);
  } finally { rmSync(fresh, { recursive: true, force: true }); }
});

test("remote refusals: custom migrations folder, and a CONTROL id that is still a placeholder", () => {
  const r1 = spawnSync("node", [join(ROOT, "scripts", "migrate.mjs"), "--migrations-root", join(ROOT, "migrations"), "--remote"], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(r1.status, 1);
  const r2 = spawnSync("node", [join(ROOT, "scripts", "migrate.mjs"), "--remote"], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /set CONTROL's database_id/);
  assert.equal(spawnSync("node", [join(ROOT, "scripts", "migrate.mjs"), "--control", "--vendors"], { cwd: ROOT, encoding: "utf8", env }).status, 1);
});

test("release refuses when a released migration changed (via the latest release-* tag)", () => {
  const repo = mkdtempSync(join(tmpdir(), "venstock-release-repo-"));
  const git = (...a) => { const x = spawnSync("git", a, { cwd: repo, encoding: "utf8" }); if (x.status) throw new Error(x.stderr); };
  try {
    git("init", "-q"); git("config", "user.email", "t@example.test"); git("config", "user.name", "t");
    for (const k of ["control", "vendor"]) cpSync(join(ROOT, "migrations", k), join(repo, "migrations", k), { recursive: true });
    git("add", "-A"); git("commit", "-q", "-m", "x"); git("tag", "release-2026-12-01");
    appendFileSync(join(repo, "migrations", "vendor", "0001_baseline.sql"), "-- edited\n");
    const r = release("--repo-root", repo);
    assert.equal(r.code, 1);
    assert.match(r.out, /0001_baseline\.sql: changed since its checksum was recorded/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("rehearsal-only flags are refused for a real release; a real release needs the real control database", () => {
  for (const args of [["--skip-tests"], ["--repo-root", "/tmp"], ["--now", NOW]]) {
    const r = node("release.mjs", args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.out, /only allowed with --local/);
  }
  const real = node("release.mjs");
  assert.equal(real.code, 1);
  assert.match(real.out, /set CONTROL's database_id/);
  assert.ok(!existsSync(join(ROOT, ".wrangler-generated", "remote", "last-release.json")), "a refused release records nothing");
});
