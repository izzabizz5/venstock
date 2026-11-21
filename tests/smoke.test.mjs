// Baseline smoke test: today's single-vendor behaviour, end to end, through the real HTTP API.
// Later steps must keep this passing unchanged (only the host it talks to changes, in step 4).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer, USERS } from "./harness.mjs";

let server, admin, anon;
const HOST = "localhost";

before(async () => {
  server = await startServer({ users: [USERS.admin, USERS.staff] });
  admin = server.client(HOST);
  anon = server.client(HOST);
  await admin.login(USERS.admin);
});
after(async () => { await server?.stop(); });

test("app shell is served", async () => {
  const r = await anon.get("/");
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Venstock<\/title>/);
  assert.equal((await anon.get("/app.js")).status, 200);
});

test("API needs a login", async () => {
  assert.equal((await anon.get("/api/items")).status, 401);
  assert.equal((await anon.get("/api/auth/me")).status, 401);
});

test("logged-in admin is fully signed in", async () => {
  const r = await admin.get("/api/auth/me");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { email: USERS.admin.email, is_admin: true, stage: "ok" });
});

test("wrong password is refused", async () => {
  const c = server.client(HOST);
  const r = await c.post("/api/auth/login", { email: USERS.staff.email, password: "nope-nope-nope" });
  assert.equal(r.status, 400);
});

let itemId;
test("items: create, edit, list, restock, export", async () => {
  const created = await admin.post("/api/items", { name: "Tee - Medium", category: "Apparel", sku: "TEE-M", price_cents: 500, stock: 10 });
  assert.equal(created.status, 200);
  itemId = created.json.id;
  assert.ok(Number.isInteger(itemId));

  const edited = await admin.put(`/api/items/${itemId}`, { name: "Tee - Medium", category: "Apparel", sku: "TEE-M", price_cents: 500, stock: 10, active: true });
  assert.equal(edited.status, 200);

  const restock = await admin.post("/api/items/restock", { items: [{ id: itemId, qty: 3 }] });
  assert.equal(restock.status, 200);

  const list = await admin.get("/api/items?all=1");
  const item = list.json.find((i) => i.id === itemId);
  assert.equal(item.stock, 13);

  const csv = await admin.get("/api/items/export");
  assert.equal(csv.status, 200);
  assert.match(csv.headers["content-type"], /text\/csv/);
  assert.match(csv.text, /"Tee - Medium","Apparel","TEE-M",5\.00,13,yes/);
});

test("items: CSV import updates by SKU and adds new rows", async () => {
  const r = await admin.post("/api/items/import", { mode: "add", rows: [
    { name: "Tee - Medium", category: "Apparel", sku: "TEE-M", stock: 2 },
    { name: "Mug", category: "Kitchen", sku: "", price_cents: 1200, stock: 4 },
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { added: 1, updated: 1, skipped: 0 });
  const list = (await admin.get("/api/items?all=1")).json;
  assert.equal(list.find((i) => i.id === itemId).stock, 15);
  assert.ok(list.some((i) => i.name === "Mug" && i.stock === 4));
});

test("settings: registers and deals round-trip", async () => {
  const deals = [{ qty: 3, unit_price_cents: 500, off_cents: 200 }];
  assert.equal((await admin.put("/api/settings", { registers: 4, deals })).status, 200);
  const r = await admin.get("/api/settings");
  assert.equal(r.json.registers, 4);
  assert.deepEqual(r.json.deals, deals);
});

test("shows and sales: start, sell, retry safely, summarise, cancel, export, end", async () => {
  const up = await admin.post("/api/shows/upcoming", { name: "Holiday Market", show_date: "2026-12-05", start_time: "10:00", end_time: "16:00" });
  assert.equal(up.status, 200);
  assert.ok((await admin.get("/api/shows/upcoming")).json.some((s) => s.id === up.json.id));
  assert.equal((await admin.post(`/api/shows/upcoming/${up.json.id}/start`)).status, 200);

  const active = (await admin.get("/api/shows/active")).json;
  assert.equal(active.name, "Holiday Market");

  const sale = {
    client_id: randomUUID(), show_id: active.id, payment_method: "cash", register: "Register 1",
    notes: "", discount_cents: 0, discount_label: "", created_at: new Date().toISOString(),
    items: [{ item_id: itemId, name: "Tee - Medium", qty: 2, price_cents: 500 }],
  };
  const first = await admin.post("/api/sales", sale);
  assert.equal(first.status, 200);
  const retry = await admin.post("/api/sales", sale);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, true, "re-uploading the same client_id must not create a second sale");

  const stockAfterSale = (await admin.get("/api/items?all=1")).json.find((i) => i.id === itemId).stock;
  assert.equal(stockAfterSale, 13);

  const summary = (await admin.get(`/api/shows/${active.id}/summary`)).json;
  assert.deepEqual(summary.by_payment, [{ payment_method: "cash", sales: 1, total_cents: 1000 }]);

  const sales = (await admin.get(`/api/shows/${active.id}/sales`)).json;
  assert.equal(sales.length, 1);
  assert.equal(sales[0].summary, "2× Tee - Medium");

  const exported = await admin.get(`/api/export?show_id=${active.id}`);
  assert.match(exported.text, /"Holiday Market".*"Tee - Medium",2,5\.00/);

  assert.equal((await admin.post(`/api/sales/${sales[0].id}/void`)).status, 200);
  assert.equal((await admin.get("/api/items?all=1")).json.find((i) => i.id === itemId).stock, 15);
  assert.deepEqual((await admin.get(`/api/shows/${active.id}/summary`)).json.by_payment, []);

  assert.equal((await admin.post(`/api/shows/${active.id}/end`)).status, 200);
  assert.equal((await admin.get("/api/shows/active")).json, null);
});

test("sales made with no show running are listed as unassigned", async () => {
  const r = await admin.post("/api/sales", {
    client_id: randomUUID(), show_id: null, payment_method: "venmo",
    items: [{ item_id: itemId, name: "Tee - Medium", qty: 1, price_cents: 500 }],
  });
  assert.equal(r.status, 200);
  const list = (await admin.get("/api/sales/unassigned")).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].payment_method, "venmo");
});

test("users: admin sees the list, staff cannot", async () => {
  const list = await admin.get("/api/users");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((u) => u.email).sort(), [USERS.admin.email, USERS.staff.email]);

  const staff = server.client(HOST);
  await staff.login(USERS.staff);
  assert.equal((await staff.get("/api/users")).status, 403);
});

test("logout ends the session", async () => {
  const c = server.client(HOST);
  await c.login(USERS.staff);
  assert.equal((await c.get("/api/items")).status, 200);
  await c.post("/api/auth/logout");
  assert.equal((await c.get("/api/items")).status, 401);
});
