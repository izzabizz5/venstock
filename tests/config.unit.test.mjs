// The generated wrangler config (scripts/lib/wrangler-config.mjs), without wrangler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderConfig, readBaseToml, LOCAL_CONTROL, vendorBinding } from "../scripts/lib/wrangler-config.mjs";
import { vendorBinding as workerVendorBinding } from "../src/lib/tenant.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(ROOT, ".wrangler-generated", "local");
const blocks = (toml) => toml.split("[[d1_databases]]").slice(1).map((b) => Object.fromEntries([...b.matchAll(/^(\w+) = "([^"]*)"$/gm)].map((m) => [m[1], m[2]])));

test("scripts and the Worker derive the same binding name", () => {
  assert.equal(vendorBinding, workerVendorBinding);
  assert.equal(vendorBinding(12), "DB_T12");
});

test("the committed wrangler.toml binds only CONTROL, and sets BASE_DOMAIN", () => {
  const base = readBaseToml(join(ROOT, "wrangler.toml"));
  assert.deepEqual(base.d1.map((d) => d.binding), ["CONTROL"]);
  assert.equal(base.d1[0].database_name, "venstock-dev-control");
  assert.equal(base.vars.BASE_DOMAIN, "localhost");
});

test("CONTROL plus one binding per vendor with a database; relative paths; vars carried over", () => {
  const toml = renderConfig({ root: ROOT, outDir: out, control: LOCAL_CONTROL, vendors: [
    { id: 1, db_name: "venstock-local-t1", db_id: "local-t1" },
    { id: 2, db_name: "venstock-local-t2", db_id: null },        // not created yet: no binding
    { id: 5, db_name: "venstock-local-t5", db_id: "local-t5" },
  ] });
  assert.deepEqual(blocks(toml), [
    { binding: "CONTROL", database_name: "venstock-local-control", database_id: "local-control", migrations_dir: "../../migrations/control" },
    { binding: "DB_T1", database_name: "venstock-local-t1", database_id: "local-t1", migrations_dir: "../../migrations/vendor" },
    { binding: "DB_T5", database_name: "venstock-local-t5", database_id: "local-t5", migrations_dir: "../../migrations/vendor" },
  ]);
  assert.match(toml, /^main = "\.\.\/\.\.\/src\/worker\.js"$/m);
  assert.match(toml, /^directory = "\.\.\/\.\.\/public"$/m);
  assert.match(toml, /^run_worker_first = true$/m);
  assert.match(toml, /^BASE_DOMAIN = "localhost"$/m);
});

test("bad ids, duplicates and odd characters are refused", () => {
  const render = (vendors) => renderConfig({ root: ROOT, outDir: out, control: LOCAL_CONTROL, vendors });
  assert.throws(() => render([{ id: 0, db_name: "a", db_id: "b" }]), /bad vendor id/);
  assert.throws(() => render([{ id: "1", db_name: "a", db_id: "b" }]), /bad vendor id/);
  assert.throws(() => render([{ id: 1, db_name: "a", db_id: "b" }, { id: 1, db_name: "c", db_id: "d" }]), /listed twice/);
  assert.throws(() => render([{ id: 1, db_name: 'x"\n[[d1_databases]]', db_id: "b" }]), /unexpected characters/);
});

test("the generated config turns off the workers.dev address and preview URLs", () => {
  const toml = renderConfig({ root: ROOT, outDir: out, control: LOCAL_CONTROL, vendors: [] });
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^preview_urls = false$/m);
  assert.doesNotMatch(toml, /^(workers_dev|preview_urls) = true$/m);
});

// A throwaway repo root with its own wrangler.toml (renderConfig reads ROOT/wrangler.toml).
import { mkdtempSync, writeFileSync, rmSync, readFileSync as readFile } from "node:fs";
import { tmpdir } from "node:os";
import { productionDomainProblem } from "../scripts/lib/wrangler-config.mjs";
function withToml(edit, fn) {
  const dir = mkdtempSync(join(tmpdir(), "venstock-toml-"));
  try {
    writeFileSync(join(dir, "wrangler.toml"), edit(readFile(join(ROOT, "wrangler.toml"), "utf8")));
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const PROD = (t) => t.replace('BASE_DOMAIN = "localhost"', 'BASE_DOMAIN = "shops.example"\n\n[[routes]]\npattern = "*.shops.example/*"\nzone_name = "shops.example"');

test("local configs always use BASE_DOMAIN = localhost and no routes, whatever wrangler.toml says", () => {
  withToml(PROD, (dir) => {
    const toml = renderConfig({ root: dir, outDir: join(dir, "gen"), control: LOCAL_CONTROL, vendors: [] });
    assert.match(toml, /^BASE_DOMAIN = "localhost"$/m);
    assert.doesNotMatch(toml, /\[\[routes\]\]/);
  });
});

test("remote configs carry wrangler.toml's BASE_DOMAIN and its wildcard route", () => {
  withToml(PROD, (dir) => {
    const toml = renderConfig({ root: dir, outDir: join(dir, "gen"), control: LOCAL_CONTROL, vendors: [], target: "remote" });
    assert.match(toml, /^BASE_DOMAIN = "shops\.example"$/m);
    assert.match(toml, /\[\[routes\]\]\npattern = "\*\.shops\.example\/\*"\nzone_name = "shops\.example"/);
    assert.match(toml, /^workers_dev = false$/m);
  });
  withToml((t) => PROD(t).replace('pattern = "*.shops.example/*"', 'pattern = "*.shops.example/*\\"\\n[evil]"'), (dir) => {
    assert.throws(() => renderConfig({ root: dir, outDir: dir, control: LOCAL_CONTROL, vendors: [], target: "remote" }));
  });
});

test("nothing remote until BASE_DOMAIN is a real domain with a wildcard route for it", () => {
  const base = (domain, routes = []) => ({ vars: { BASE_DOMAIN: domain }, routes });
  const ok = [{ pattern: "*.shops.example/*", zone_name: "shops.example" }];
  assert.equal(productionDomainProblem(base("shops.example", ok)), null);
  for (const d of ["localhost", "", "<BASE_DOMAIN>", "shops", "a.localhost", "Shops.Example", "shops.example.", "-x.example"]) {
    assert.match(productionDomainProblem(base(d, ok)), /set BASE_DOMAIN/, JSON.stringify(d));
  }
  assert.match(productionDomainProblem(base("shops.example")), /add a \[\[routes\]\] block/);
  assert.match(productionDomainProblem(base("shops.example", [{ pattern: "shops.example/*", zone_name: "shops.example" }])), /\[\[routes\]\]/);
  assert.match(productionDomainProblem(base("shops.example", [{ pattern: "*.other.example/*", zone_name: "other.example" }])), /\[\[routes\]\]/);
  // The committed wrangler.toml is not set up for production yet, so every remote command refuses.
  assert.notEqual(productionDomainProblem(readBaseToml(join(ROOT, "wrangler.toml"))), null);
});
