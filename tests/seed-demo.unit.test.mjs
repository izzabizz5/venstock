// scripts/seed-demo.mjs is LOCAL ONLY: --remote, anything naming a remote database, and unknown arguments are refused
// before any database is opened. It runs in a copy of the repo whose wrangler.toml would ALLOW remote commands
// (real-looking domain, route and control id) with a fake npx that only logs, so a guard that failed could not reach
// Cloudflare, and the test would see it. Part of test:fast: nothing here starts wrangler or opens a database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tomlFor, ROOT } from "./wrangler-toml.mjs";

let dir, copy, npxLog, env;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "venstock-seed-guard-"));
  copy = join(dir, "repo");
  for (const p of ["scripts", "src", "migrations", "package.json"]) cpSync(join(ROOT, p), join(copy, p), { recursive: true });
  writeFileSync(join(copy, "wrangler.toml"), tomlFor({ domain: "shops.example", controlId: "11111111-2222-3333-4444-555555555555" }));
  mkdirSync(join(dir, "bin"));
  npxLog = join(dir, "npx.log");
  writeFileSync(npxLog, "");
  writeFileSync(join(dir, "bin", "npx"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${npxLog}"\nexit 97\n`);
  chmodSync(join(dir, "bin", "npx"), 0o755);
  env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    VENSTOCK_PERSIST_TO: join(dir, "state"), VENSTOCK_GENERATED_DIR: join(dir, "gen") };
});
after(() => rmSync(dir, { recursive: true, force: true }));

const seed = (...args) => {
  const r = spawnSync(process.execPath, [join(copy, "scripts", "seed-demo.mjs"), ...args], { cwd: copy, encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

test("--remote is refused, in any position and form", () => {
  for (const args of [["--remote"], ["--replace", "--remote"], ["--remote", "--replace"], ["--remote=true"], ["--local", "--remote"]]) {
    const r = seed(...args);
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, /LOCAL ONLY/, args.join(" "));
  }
});

test("any argument naming a remote database is refused", () => {
  for (const a of ["venstock-dev-control", "venstock-dev-t1", "show-pos-db", "--db=venstock-dev-t3", "remote"]) {
    const r = seed(a);
    assert.equal(r.code, 1, `${a}: ${r.out}`);
    assert.match(r.out, /LOCAL ONLY/, a);
  }
});

test("unknown arguments are refused with the usage line", () => {
  for (const a of ["--tenant", "acme", "--force"]) {
    const r = seed(a);
    assert.equal(r.code, 1, `${a}: ${r.out}`);
    assert.match(r.out, /Unknown argument/, a);
    assert.match(r.out, /Usage: node scripts\/seed-demo\.mjs/, a);
  }
});

test("no refusal opened a database or called npx", () => {
  assert.equal(readFileSync(npxLog, "utf8"), "", "npx was never called");
  assert.ok(!existsSync(join(dir, "state")), "no local state was created");
  assert.ok(!existsSync(join(dir, "gen")), "no config was generated");
});
