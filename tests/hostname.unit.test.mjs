// Hostname parsing (src/lib/tenant.js). Pure: no server. The request-level 404/403/503 tests come with the
// resolver in step 6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHost, RESERVED_SLUGS, isValidSlug } from "../src/lib/tenant.js";

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

test("vendor slugs: 3-32 of a-z 0-9 and hyphens, no hyphen at either end, never -- in positions 3-4", () => {
  for (const ok of ["abc", "demo", "my-shop-2", "a-b", "x".repeat(32), "123", "a-b-c--d", "abc--d", "shop--x"]) {
    assert.equal(isValidSlug(ok), true, ok);
  }
  for (const bad of ["", "ab", "x".repeat(33), "-abc", "abc-", "Abc", "ab_c", "a.bc", "ab c", "déjà", "xn--dmo-xla", "xn--80ak6aa92e",
    "ab--cd", "zz--", "a1--b", null, undefined, 123]) {
    assert.equal(isValidSlug(bad), false, String(bad));
  }
});

test("parseHost: anything that can't be a vendor slug is none (so it never reaches the control database)", () => {
  const B = "example.com";
  for (const h of ["ab.example.com", "xn--dmo-xla.example.com", "ab--cd.example.com", `${"x".repeat(33)}.example.com`,
    "-abc.example.com", "abc-.example.com", "a_b_c.example.com", "x.y.example.com", "%41bc.example.com", "abc.example.com:8788",
    "abc..example.com", "abc.example.com..", ".example.com", "example.com", "abcexample.com"]) {
    assert.deepEqual(parseHost(h, B), { kind: "none" }, h);
  }
  assert.deepEqual(parseHost("abc.example.com", B), { kind: "tenant", slug: "abc" });
  assert.deepEqual(parseHost("www.example.com", B), { kind: "reserved", slug: "www" });
});
