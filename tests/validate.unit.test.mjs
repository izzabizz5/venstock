// Restock and sale validation (src/lib/validate.js), without a server. The HTTP versions: tests/restock.test.mjs and
// tests/sales.isolation.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRestock, MAX_RESTOCK_QTY, MAX_RESTOCK_ITEMS, validateSale, MAX_SALE_LINES, MAX_SALE_QTY } from "../src/lib/validate.js";

const bad = /whole number from 1 to 100000/;

test("valid lists pass through as { id, qty } only", () => {
  assert.deepEqual(validateRestock({ items: [{ id: 1, qty: 3, stock: 999, tenant_id: 2 }, { id: 2, qty: 1 }] }),
    { items: [{ id: 1, qty: 3 }, { id: 2, qty: 1 }] });
});

test("the limits themselves are allowed", () => {
  assert.equal(MAX_RESTOCK_QTY, 100000);
  assert.equal(MAX_RESTOCK_ITEMS, 100);
  const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, qty: 100000 }));
  assert.deepEqual(validateRestock({ items }).items.length, 100);
});

test("empty, missing, malformed and too-long lists are refused", () => {
  for (const body of [{}, { items: [] }, { items: "1,2" }, { items: null }, null, undefined]) {
    assert.equal(validateRestock(body).error, "Nothing to restock", JSON.stringify(body));
  }
  assert.match(validateRestock({ items: Array.from({ length: 101 }, (_, i) => ({ id: i + 1, qty: 1 })) }).error, /at most 100 items/);
});

test("negative, zero, fractional, non-numeric, oversized and missing values are refused", () => {
  for (const entry of [{ id: 1, qty: 0 }, { id: 1, qty: -1 }, { id: 1, qty: 1.5 }, { id: 1, qty: "3" }, { id: 1, qty: 100001 },
    { id: 1, qty: NaN }, { id: 1, qty: Infinity }, { id: 1 }, { qty: 1 }, { id: 0, qty: 1 }, { id: -1, qty: 1 }, { id: 1.5, qty: 1 },
    { id: "1", qty: 1 }, null, 7]) {
    assert.match(validateRestock({ items: [entry] }).error, bad, JSON.stringify(entry));
  }
});

test("one bad entry refuses the whole list", () => {
  assert.match(validateRestock({ items: [{ id: 1, qty: 2 }, { id: 2, qty: 0 }] }).error, bad);
});

// ---------- sales ----------
const UUID = "3f2b8c1e-9d4a-4c7b-8e2f-1a2b3c4d5e6f";
const good = (over = {}) => ({ client_id: UUID, payment_method: "cash", items: [{ item_id: 1, qty: 2 }], ...over });

test("sale: a valid sale keeps only what the server uses; prices and names from the device are dropped", () => {
  const { sale } = validateSale(good({ client_id: UUID.toUpperCase(), show_id: 4, discount_cents: 150, discount_label: "  Bundle ",
    register: " Register 2 ", notes: "n".repeat(2000), created_at: "2026-11-21T10:00:00.000Z", total_cents: 1, tenant_id: 9,
    items: [{ item_id: 1, qty: 2, price_cents: 1, name: "Free" }] }));
  assert.deepEqual(sale, { client_id: UUID, payment_method: "cash", show_id: 4, created_at: "2026-11-21T10:00:00.000Z", register: "Register 2",
    notes: "n".repeat(1000), discount_cents: 150, discount_label: "Bundle", lines: [{ item_id: 1, qty: 2 }] });
});

test("sale: defaults for optional fields", () => {
  const { sale } = validateSale(good());
  assert.equal(sale.show_id, null);
  assert.equal(sale.discount_cents, 0);
  assert.ok(!Number.isNaN(Date.parse(sale.created_at)));
});

test("sale: limits are allowed", () => {
  assert.equal(MAX_SALE_LINES, 100);
  assert.equal(MAX_SALE_QTY, 10000);
  assert.ok(validateSale(good({ items: Array.from({ length: 100 }, (_, i) => ({ item_id: i + 1, qty: 10000 })) })).sale);
});

test("sale: malformed sales are refused", () => {
  const bad = [null, "x", {}, good({ client_id: "abc" }), good({ client_id: 5 }), good({ client_id: `${UUID}x` }),
    good({ payment_method: "card" }), good({ payment_method: undefined }), good({ items: [] }), good({ items: {} }),
    good({ items: Array.from({ length: 101 }, () => ({ item_id: 1, qty: 1 })) }),
    ...[0, -1, 1.5, "2", null, 10001, NaN].map((qty) => good({ items: [{ item_id: 1, qty }] })),
    ...[0, -1, "1", 1.5, null].map((item_id) => good({ items: [{ item_id, qty: 1 }] })),
    good({ items: [null] }), good({ show_id: "4" }), good({ show_id: 0 }), good({ show_id: 1.5 }),
    good({ discount_cents: -1 }), good({ discount_cents: "5" }), good({ discount_cents: 0.5 }),
    good({ created_at: "soon" }), good({ created_at: 12345 }), good({ created_at: "x".repeat(41) })];
  for (const body of bad) assert.ok(validateSale(body).error, JSON.stringify(body)?.slice(0, 100));
});
