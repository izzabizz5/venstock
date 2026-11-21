// Hostname parsing (src/lib/tenant.js). Pure: no server. The request-level 404/403/503 tests come with the
// resolver in step 6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHost, RESERVED_SLUGS } from "../src/lib/tenant.js";

test("parseHost: one level under BASE_DOMAIN, reserved slugs flagged", () => {
  const B = "localhost";
  assert.deepEqual(parseHost("demo.localhost", B), { kind: "tenant", slug: "demo" });
  assert.deepEqual(parseHost("DEMO.LocalHost", B), { kind: "tenant", slug: "demo" });
  assert.deepEqual(parseHost("demo.localhost.", B), { kind: "tenant", slug: "demo" });
  assert.deepEqual(parseHost("my-shop-2.localhost", B), { kind: "tenant", slug: "my-shop-2" });
  assert.deepEqual(parseHost("admin.localhost", B), { kind: "reserved", slug: "admin" });
  for (const h of ["localhost", "x.demo.localhost", "-demo.localhost", "demo-.localhost", "de_mo.localhost",
    "demo.example.com", "demolocalhost", "", ".localhost", "a".repeat(64) + ".localhost", "127.0.0.1"]) {
    assert.deepEqual(parseHost(h, B), { kind: "none" }, h);
  }
  assert.deepEqual(parseHost("demo.localhost", ""), { kind: "none" }, "no BASE_DOMAIN means nothing resolves");
  assert.deepEqual(parseHost("shop.venstock.example", "venstock.example"), { kind: "tenant", slug: "shop" });
  assert.deepEqual(parseHost("a.b.venstock.example", "venstock.example"), { kind: "none" });
});

test("reserved slugs are exactly the agreed list", () => {
  assert.deepEqual([...RESERVED_SLUGS].sort(), ["admin", "api", "app", "assets", "cdn", "dev", "docs", "help",
    "login", "mail", "staging", "static", "status", "support", "www"]);
});
