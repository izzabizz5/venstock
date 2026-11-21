// Restock validation (src/lib/validate.js), without a server. tests/restock.test.mjs checks the same rules over HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRestock, MAX_RESTOCK_QTY, MAX_RESTOCK_ITEMS } from "../src/lib/validate.js";

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
