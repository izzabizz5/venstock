// Restock validation: all or nothing, positive whole numbers only, existing items only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, USERS } from "./harness.mjs";

let server, admin, itemId, otherId;
before(async () => {
  server = await startServer({ users: [USERS.admin] });
  admin = server.client();
  await admin.login(USERS.admin);
  itemId = (await admin.post("/api/items", { name: "Tee - Medium", price_cents: 500, stock: 10 })).json.id;
  otherId = (await admin.post("/api/items", { name: "Mug", price_cents: 900, stock: 2 })).json.id;
});
after(async () => { await server?.stop(); });

const stocks = async () => Object.fromEntries((await admin.get("/api/items?all=1")).json.map((i) => [i.id, i.stock]));

test("valid restock adds to several items in one go", async () => {
  const r = await admin.post("/api/items/restock", { items: [{ id: itemId, qty: 3 }, { id: otherId, qty: 1 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, count: 2 });
  assert.deepEqual(await stocks(), { [itemId]: 13, [otherId]: 3 });
});

test("negative, zero, fractional, non-numeric and oversized quantities are refused and change nothing", async () => {
  const before = await stocks();
  const bad = [
    { id: itemId, qty: -5 }, { id: itemId, qty: 0 }, { id: itemId, qty: 2.5 }, { id: itemId, qty: "5" },
    { id: itemId, qty: "abc" }, { id: itemId, qty: null }, { id: itemId }, { id: itemId, qty: 100001 },
    { id: String(itemId), qty: 1 }, { id: -itemId, qty: 1 }, { id: 1.5, qty: 1 }, { qty: 1 }, null, "x",
  ];
  for (const entry of bad) {
    const r = await admin.post("/api/items/restock", { items: [entry] });
    assert.equal(r.status, 400, JSON.stringify(entry));
  }
  // JSON can't carry Infinity or NaN; send them as raw text to be sure they don't sneak through as something else.
  for (const raw of [`{"items":[{"id":${itemId},"qty":1e400}]}`, `{"items":[{"id":${itemId},"qty":-1e400}]}`]) {
    assert.equal((await admin.req("POST", "/api/items/restock", raw)).status, 400, raw);
  }
  assert.deepEqual(await stocks(), before);
});

test("one bad entry refuses the whole request", async () => {
  const before = await stocks();
  const r = await admin.post("/api/items/restock", { items: [{ id: itemId, qty: 3 }, { id: otherId, qty: -3 }] });
  assert.equal(r.status, 400);
  assert.deepEqual(await stocks(), before);
});

test("an id that doesn't exist refuses the whole request with 404", async () => {
  const before = await stocks();
  const r = await admin.post("/api/items/restock", { items: [{ id: itemId, qty: 3 }, { id: 999999, qty: 1 }] });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "Not found" });
  assert.deepEqual(await stocks(), before);
});

test("empty, malformed and too-long lists are refused", async () => {
  const before = await stocks();
  for (const body of [{}, { items: [] }, { items: "x" }, { items: {} }]) {
    assert.equal((await admin.post("/api/items/restock", body)).status, 400, JSON.stringify(body));
  }
  const tooMany = Array.from({ length: 101 }, () => ({ id: itemId, qty: 1 }));
  assert.equal((await admin.post("/api/items/restock", { items: tooMany })).status, 400);
  assert.deepEqual(await stocks(), before);
});

test("the limits themselves are allowed: 100 entries, quantity 100000", async () => {
  const hundred = Array.from({ length: 100 }, () => ({ id: otherId, qty: 1 }));
  assert.equal((await admin.post("/api/items/restock", { items: hundred })).status, 200);
  assert.equal((await stocks())[otherId], 103);
  assert.equal((await admin.post("/api/items/restock", { items: [{ id: itemId, qty: 100000 }] })).status, 200);
});
