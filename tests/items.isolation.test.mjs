// Items are vendor data, in each vendor's own database. Vendor A (acme) must not read, change, restock or import
// over vendor B's (demo's) items, whatever ids, SKUs or vendor fields it sends.
// Ids are per database now, so two cases matter: an id that only exists at demo must look exactly like a missing id
// at acme, and an id that exists at BOTH must only ever touch the caller's own row.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, USERS } from "./harness.mjs";

const ACME = { email: "owner@acme.test", password: "test-password-acme", totpSecret: "MFRGGZDFMZTWQ2LK", isAdmin: true };
const NOT_FOUND = { error: "Not found" };
// demo gets three filler items first, so its test item (id 4) has an id that never exists at acme.
const FILLER = ["one", "two", "three"].map((n) => `INSERT INTO items (name, price_cents, stock) VALUES ('demo-filler-${n}', 100, 1);`).join("\n");
let server, demo, acme, demoItem, acmeItem;

before(async () => {
  server = await startServer({ vendors: [
    { slug: "demo", users: [USERS.admin], seedSql: FILLER },
    { slug: "acme", users: [ACME] },
  ] });
  demo = server.client("demo.localhost");
  acme = server.client("acme.localhost");
  await demo.login(USERS.admin);
  await acme.login(ACME);
  demoItem = (await demo.post("/api/items", { name: "Demo Tee", category: "Apparel", sku: "SHARED-SKU", price_cents: 500, stock: 10 })).json.id;
  acmeItem = (await acme.post("/api/items", { name: "Acme Mug", category: "Kitchen", sku: "MUG", price_cents: 900, stock: 3 })).json.id;
  assert.equal(demoItem, 4);
  assert.equal(acmeItem, 1);
});
after(async () => { await server?.stop(); });

const demoRows = () => server.query("DB_T1", "SELECT id, name, category, sku, price_cents, stock, active FROM items ORDER BY id");
const acmeRows = () => server.query("DB_T2", "SELECT id, name, category, sku, price_cents, stock, active FROM items ORDER BY id");
let DEMO_ORIGINAL;
test("baseline", () => { DEMO_ORIGINAL = demoRows(); assert.equal(DEMO_ORIGINAL.length, 4); });

test("each vendor lists only its own items (active and all)", async () => {
  for (const q of ["", "?all=1"]) {
    assert.deepEqual((await acme.get(`/api/items${q}`)).json.map((i) => i.name), ["Acme Mug"]);
    assert.deepEqual((await demo.get(`/api/items${q}`)).json.map((i) => i.name), ["demo-filler-one", "demo-filler-two", "demo-filler-three", "Demo Tee"]);
  }
});

test("items export contains only the vendor's own items", async () => {
  const csv = (await acme.get("/api/items/export")).text;
  assert.match(csv, /Acme Mug/);
  assert.doesNotMatch(csv, /Demo Tee|SHARED-SKU|demo-filler/);
});

test("PUT an id that only exists at demo: 404, exactly like a missing id, and nothing changes", async () => {
  const edit = { name: "Hacked", category: "x", sku: "x", price_cents: 1, stock: 0, active: false };
  const foreign = await acme.put(`/api/items/${demoItem}`, edit);
  const missing = await acme.put("/api/items/99999", edit);
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.json, NOT_FOUND);
  assert.equal(foreign.text, missing.text);
  assert.deepEqual(demoRows(), DEMO_ORIGINAL);
});

test("an id that exists at both vendors: acme's edit and restock change acme's row only", async () => {
  assert.ok(DEMO_ORIGINAL.some((r) => r.id === acmeItem), "demo also has an item with acme's item id");
  const edited = await acme.put(`/api/items/${acmeItem}`, { name: "Acme Mug", category: "Kitchen", sku: "MUG", price_cents: 950, stock: 3, active: true });
  assert.equal(edited.status, 200);
  assert.equal((await acme.post("/api/items/restock", { items: [{ id: acmeItem, qty: 2 }] })).status, 200);
  assert.deepEqual(acmeRows(), [{ id: 1, name: "Acme Mug", category: "Kitchen", sku: "MUG", price_cents: 950, stock: 5, active: 1 }]);
  assert.deepEqual(demoRows(), DEMO_ORIGINAL);
});

test("restock with an id only demo has: refused as a whole, like a missing id; nothing changes", async () => {
  const acmeBefore = acmeRows();
  const onlyForeign = await acme.post("/api/items/restock", { items: [{ id: demoItem, qty: 50 }] });
  const mixed = await acme.post("/api/items/restock", { items: [{ id: acmeItem, qty: 5 }, { id: demoItem, qty: 50 }] });
  const missing = await acme.post("/api/items/restock", { items: [{ id: 99999, qty: 5 }] });
  for (const r of [onlyForeign, mixed, missing]) { assert.equal(r.status, 404); assert.deepEqual(r.json, NOT_FOUND); }
  assert.deepEqual(demoRows(), DEMO_ORIGINAL);
  assert.deepEqual(acmeRows(), acmeBefore, "acme's own item untouched by the refused mixed request");
});

test("import never matches or updates another vendor's items, even with the same SKU and name", async () => {
  const r = await acme.post("/api/items/import", { mode: "set", rows: [
    { name: "Demo Tee", category: "Apparel", sku: "SHARED-SKU", price_cents: 1, stock: 0 },
  ] });
  assert.deepEqual(r.json, { added: 1, updated: 0, skipped: 0 });
  assert.deepEqual(demoRows(), DEMO_ORIGINAL);
  assert.equal(acmeRows().length, 2);
});

test("mass assignment: vendor fields and ids in bodies are ignored on create, edit, import and restock", async () => {
  const created = await acme.post("/api/items", { name: "Sneaky", tenant_id: 1, tenantId: 1, slug: "demo", id: demoItem, price_cents: 100, stock: 1 });
  assert.equal(created.status, 200);
  assert.notEqual(created.json.id, demoItem);
  const edited = await acme.put(`/api/items/${created.json.id}`, { name: "Sneaky 2", tenant_id: 1, id: demoItem, active: true, price_cents: 100, stock: 1 });
  assert.equal(edited.status, 200);
  const imported = await acme.post("/api/items/import", { mode: "set", rows: [{ name: "Imported", tenant_id: 1, id: demoItem, stock: 1 }] });
  assert.deepEqual(imported.json, { added: 1, updated: 0, skipped: 0 });
  const restock = await acme.post("/api/items/restock", { tenant_id: 1, slug: "demo", items: [{ id: acmeItem, qty: 1, tenant_id: 1 }] });
  assert.equal(restock.status, 200);
  assert.deepEqual(acmeRows().map((r) => r.name), ["Acme Mug", "Demo Tee", "Sneaky 2", "Imported"]);
  assert.deepEqual(demoRows(), DEMO_ORIGINAL, "demo's database is exactly as it was");
});

test("the demo vendor still works normally on its own items", async () => {
  assert.equal((await demo.post("/api/items/restock", { items: [{ id: demoItem, qty: 1 }] })).status, 200);
  assert.equal(demoRows().find((r) => r.id === demoItem).stock, 11);
  const orig = DEMO_ORIGINAL.find((r) => r.id === demoItem);
  assert.equal((await demo.put(`/api/items/${demoItem}`, { ...orig, active: true })).status, 200);
  assert.deepEqual(demoRows(), DEMO_ORIGINAL);
});
