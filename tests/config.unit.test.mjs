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

test("the committed wrangler.toml binds only CONTROL, and is either pre-launch or fully set for production", () => {
  const base = readBaseToml(join(ROOT, "wrangler.toml"));
  assert.deepEqual(base.d1.map((d) => d.binding), ["CONTROL"]);
  assert.equal(base.d1[0].database_name, "venstock-dev-control");
  if (base.vars.BASE_DOMAIN === "localhost") {
    assert.deepEqual(base.routes ?? [], [], "pre-launch: no routes");
  } else {
    // Launch settings (docs/before-first-vendor.md, section 3): a real domain, its wildcard route and the real
    // control database id, all three. Never half of them.
    assert.equal(productionDomainProblem(base), null);
    assert.match(base.d1[0].database_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { productionDomainProblem } from "../scripts/lib/wrangler-config.mjs";
import { tomlFor } from "./wrangler-toml.mjs";
function withToml(toml, fn) {
  const dir = mkdtempSync(join(tmpdir(), "venstock-toml-"));
  try {
    writeFileSync(join(dir, "wrangler.toml"), toml);
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const PROD = tomlFor({ domain: "shops.example" });

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
  withToml(PROD.replace('pattern = "*.shops.example/*"', 'pattern = "*.shops.example/*\\"\\n[evil]"'), (dir) => {
    assert.ok(PROD.includes('pattern = "*.shops.example/*"'), "the fixture has the route this case corrupts");
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
  // A pre-launch wrangler.toml (localhost, no routes) is refused for remote. Whether the committed file is pre-launch
  // or fully set is checked by "the committed wrangler.toml binds only CONTROL ..." above.
  withToml(tomlFor(), (dir) => assert.match(productionDomainProblem(readBaseToml(join(dir, "wrangler.toml"))), /set BASE_DOMAIN/));
  withToml(tomlFor({ domain: "shops.example", routes: false }), (dir) =>
    assert.match(productionDomainProblem(readBaseToml(join(dir, "wrangler.toml"))), /add a \[\[routes\]\] block/));
});
