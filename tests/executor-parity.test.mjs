// Local and remote runs of every script send the SAME statements (SQL and parameters) in the SAME order.
// Each flow runs twice in a copy of the repo, once plain (local) and once with --remote, with a recording executor
// (tests/fixtures/record-executor.mjs, loaded with node --import) in place of node:sqlite and wrangler. Nothing
// reaches wrangler or Cloudflare: a fake npx that fails and logs is first on PATH, and its log must stay empty.
//
// The only values allowed to differ are named below (NORMALIZE): timestamps, random invites, the database-name
// prefix (venstock-local- vs venstock-dev-) and database ids (local-t<n> vs the id Cloudflare assigns).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { localRun } from "../scripts/lib/local-d1.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "tests", "fixtures", "record-executor.mjs");
const CONTROL_ID = "11111111-2222-3333-4444-555555555555";
const LATEST_VENDOR = readdirSync(join(ROOT, "migrations", "vendor")).filter((f) => f.endsWith(".sql")).sort().at(-1);
let copy, npxLog;

before(() => {
  copy = mkdtempSync(join(tmpdir(), "venstock-parity-"));
  for (const p of ["scripts", "src", "migrations", "public", "package.json"]) cpSync(join(ROOT, p), join(copy, p), { recursive: true });
  writeFileSync(join(copy, "wrangler.toml"), readFileSync(join(ROOT, "wrangler.toml"), "utf8")
    .replace(/BASE_DOMAIN = "localhost"/, 'BASE_DOMAIN = "shops.example"\n\n[[routes]]\npattern = "*.shops.example/*"\nzone_name = "shops.example"')
      .replace(/(binding = "CONTROL"\ndatabase_name = "venstock-dev-control"\ndatabase_id = )"<>"/, `$1"${CONTROL_ID}"`));
  // migrations' checksums are checked against the latest release-* tag; the copy has no git, so no tags.
  mkdirSync(join(copy, "bin"));
  npxLog = join(copy, "npx.log");
  writeFileSync(npxLog, "");
  writeFileSync(join(copy, "bin", "npx"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${npxLog}"\necho "npx must not run in this test" >&2\nexit 97\n`);
  chmodSync(join(copy, "bin", "npx"), 0o755);
});
after(() => rmSync(copy, { recursive: true, force: true }));

function runFlow(mode) {
  const dir = join(copy, `run-${mode}`);
  mkdirSync(dir);
  const log = join(dir, "ops.jsonl");
  const env = { ...process.env, PATH: `${join(copy, "bin")}:${process.env.PATH}`, VENSTOCK_RECORD_LOG: log,
    VENSTOCK_RECORD_STATE: join(dir, "db"), VENSTOCK_PERSIST_TO: join(dir, "unused-state"), VENSTOCK_GENERATED_DIR: join(dir, "gen") };
  const extra = mode === "remote" ? ["--remote"] : [];
  const exits = [];
  const script = (name, ...args) => {
    writeFileSync(log, readFileSync(log, "utf8") + JSON.stringify({ op: "script", name, args }) + "\n");
    const r = spawnSync(process.execPath, ["--import", HOOK, join(copy, "scripts", name), ...args, ...extra], { cwd: copy, encoding: "utf8", env });
    exits.push({ name, args, code: r.status, err: r.status ? r.stderr.trim().split("\n").at(-1) : "" });
  };
  writeFileSync(log, "");
  const controlId = mode === "remote" ? CONTROL_ID : "local-control";

  script("migrate.mjs", "--control");
  script("create-tenant.mjs", "demo", "Demo Shop", "owner@demo.test");
  script("create-tenant.mjs", "acme", "Acme Crafts", "owner@acme.test");
  script("create-tenant.mjs", "demo", "Again", "x@demo.test");                // refused: slug taken
  script("add-admin.mjs", "--tenant", "demo", "second@demo.test");
  script("add-admin.mjs", "--tenant", "demo", "second@demo.test");             // reset
  script("create-platform-admin.mjs", "staff@venstock.test");
  script("create-platform-admin.mjs", "staff@venstock.test");                  // reset
  script("create-platform-admin.mjs", "--disable", "staff@venstock.test");
  script("create-platform-admin.mjs", "staff@venstock.test");                  // re-enable
  // Two vendors stuck in "provisioning" (seeded directly, the same in both runs; not recorded).
  localRun(join(dir, "db"), controlId, `INSERT INTO tenants (slug, name, status, db_binding, db_name, owner_email, created_at, status_changed_at)
    VALUES ('half', 'Half', 'provisioning', 'pending', 'pending', 'o@half.test', 'x', 'x'),
           ('stuck', 'Stuck', 'provisioning', 'pending', 'pending', 'o@stuck.test', 'x', 'x');`);
  script("create-tenant.mjs", "--resume", "half");
  script("create-tenant.mjs", "--abandon", "stuck");
  script("migrate.mjs");
  script("build-config.mjs");

  const ops = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { ops, exits };
}

// Values that legitimately differ between a local and a remote run, replaced by a label before comparing.
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
function normalize(ops, dbIds) {
  return ops.map(({ mode, ...o }) => {
    if (!o.params) return o;
    const params = o.params.map((p) => {
      if (typeof p === "string" && ISO.test(p)) return "<now>";
      if (typeof p === "string" && /^[A-Za-z0-9_-]{43}$/.test(p)) return "<invite-hash>";
      if (typeof p === "number" && p > 1.7e12) return "<expires>";
      if (typeof p === "string" && dbIds.has(p)) return "<db-id>";
      if (typeof p === "string") return p.replace(/^venstock-(local|dev)-/, "venstock-<env>-");
      return p;
    });
    return { ...o, params };
  });
}

let local, remote;
test("both runs complete the same flows with the same results, and nothing calls npx", () => {
  local = runFlow("local");
  remote = runFlow("remote");
  assert.deepEqual(remote.exits.map(({ name, args, code }) => ({ name, args, code })), local.exits.map(({ name, args, code }) => ({ name, args, code })));
  assert.deepEqual(local.exits.map((e) => e.code), [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], JSON.stringify(local.exits, null, 1));
  assert.equal(readFileSync(npxLog, "utf8"), "", "no wrangler process was started in either run");
});

test("local and remote send identical SQL and parameters, in the same order", () => {
  const stmts = (ops) => ops.filter((o) => o.op !== "executor" && o.op !== "createDatabase");
  const remoteIds = new Set(remote.ops.filter((o) => o.op === "run" && /SET db_id = \?/.test(o.sql)).map((o) => o.params[0]));
  const localIds = new Set(local.ops.filter((o) => o.op === "run" && /SET db_id = \?/.test(o.sql)).map((o) => o.params[0]));
  const a = normalize(stmts(local.ops), localIds), b = normalize(stmts(remote.ops), remoteIds);
  assert.ok(a.length > 100, `a real amount of SQL was compared (${a.length} operations)`);
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) assert.deepEqual(b[i], a[i], `operation ${i}`);
  // The normalization only ever touched the named kinds of value.
  assert.deepEqual([...localIds].sort(), ["local-t1", "local-t2", "local-t3"]);
  assert.equal(remoteIds.size, 3);
  for (const id of remoteIds) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("only the remote run creates databases, and only venstock-dev-t<id> ones", () => {
  assert.deepEqual(local.ops.filter((o) => o.op === "createDatabase"), []);
  assert.deepEqual(remote.ops.filter((o) => o.op === "createDatabase").map((o) => o.name), ["venstock-dev-t1", "venstock-dev-t2", "venstock-dev-t3"]);
});

test("a script without --remote only ever gets the local executor", () => {
  assert.ok(local.ops.some((o) => o.op === "executor"));
  for (const o of local.ops) if (o.mode) assert.equal(o.mode, "local", JSON.stringify(o));
  for (const o of remote.ops) if (o.mode) assert.equal(o.mode, "remote", JSON.stringify(o));
});

test("--remote refuses a vendor database whose name breaks the rule, before any statement reaches it", () => {
  const dir = join(copy, "run-badname");
  mkdirSync(dir);
  const log = join(dir, "ops.jsonl");
  const env = { ...process.env, PATH: `${join(copy, "bin")}:${process.env.PATH}`, VENSTOCK_RECORD_LOG: log, VENSTOCK_RECORD_STATE: join(dir, "db") };
  const run = (name, ...args) => spawnSync(process.execPath, ["--import", HOOK, join(copy, "scripts", name), ...args, "--remote"], { cwd: copy, encoding: "utf8", env });
  assert.equal(run("migrate.mjs", "--control").status, 0);
  localRun(join(dir, "db"), CONTROL_ID, `INSERT INTO tenants (id, slug, name, status, db_binding, db_name, db_id, owner_email, created_at, status_changed_at)
    VALUES (1, 'legacy', 'Legacy', 'active', 'DB_T1', 'show-pos-db', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'o@l.test', 'x', 'x');
    UPDATE tenants SET schema_version = '${LATEST_VENDOR}' WHERE id = 1;`); // up to date, so only the name can be the reason
  writeFileSync(log, "");
  for (const [name, args] of [["add-admin.mjs", ["--tenant", "legacy", "x@l.test"]], ["build-config.mjs", []], ["migrate.mjs", ["--vendors"]], ["create-tenant.mjs", ["newshop", "New", "n@n.test"]]]) {
    const r = run(name, ...args);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /Refusing --remote: vendor 1's database is show-pos-db/, name);
  }
  const ops = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(ops.length > 0);
  for (const o of ops) assert.ok(!o.binding || o.binding === "CONTROL", `nothing ran on a vendor binding: ${JSON.stringify(o)}`);
  assert.ok(!ops.some((o) => o.op === "run"), "nothing was written");
  assert.equal(readFileSync(npxLog, "utf8"), "");
});

test("--remote must be spelled exactly; environment variables never make a script remote", () => {
  const dir = mkdtempSync(join(tmpdir(), "venstock-exec-")); // opens a local database file: full suite only
  try {
    const env = { ...process.env, VENSTOCK_PERSIST_TO: join(dir, "s"), VENSTOCK_GENERATED_DIR: join(dir, "g") };
    const run = (args, extra = {}) => spawnSync(process.execPath, [join(ROOT, "scripts", "create-platform-admin.mjs"), "a@b.test", ...args],
      { cwd: ROOT, encoding: "utf8", env: { ...env, ...extra } });
    for (const flag of ["--remote=1", "--REMOTE", "-remote", "--remote-", "—remote"]) {
      const r = run([flag]);
      assert.notEqual(r.status, 0, flag);
      assert.doesNotMatch(r.stdout, /REMOTE/, flag);
    }
    const r = run([], { REMOTE: "1", VENSTOCK_REMOTE: "1", WRANGLER_REMOTE: "1", CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_API_TOKEN: "x" });
    assert.match(r.stdout, /About to touch LOCAL D1 databases/);
    assert.doesNotMatch(r.stdout, /REMOTE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
