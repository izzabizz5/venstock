// Sales: uploads are idempotent per vendor database, written atomically, priced from the vendor's own items, and
// can't reach another vendor's items, shows or sales. Ids overlap on purpose: both vendors have items 1 and 2.
//   demo: items 1 Demo Tee 500, 2 Demo Hat 1500, 3 Demo Only 700; show 1 (ended) and show 2 (running)
//   acme: items 1 Acme Mug 900, 2 Acme Bowl 1200; no shows
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer, USERS } from "./harness.mjs";

const ACME = { email: "owner@acme.test", password: "test-password-acme", totpSecret: "MFRGGZDFMZTWQ2LK", isAdmin: true };
const NOT_IN_SHOP = { error: "This sale refers to an item or show that isn't in this shop" };
// Aborts any sale line with qty 4242: lets a test make a sale fail halfway through its batch.
const FAIL_TRIGGER = "CREATE TRIGGER fail_line BEFORE INSERT ON sale_items WHEN NEW.qty = 4242 BEGIN SELECT RAISE(ABORT, 'forced failure'); END;";
let server, demo, acme;

before(async () => {
  server = await startServer({ vendors: [
    { slug: "demo", users: [USERS.admin], seedSql: `
      INSERT INTO items (id, name, price_cents, stock) VALUES (1, 'Demo Tee', 500, 10), (2, 'Demo Hat', 1500, 5), (3, 'Demo Only', 700, 4);
      INSERT INTO shows (id, name, started_at, ended_at) VALUES (1, 'Old Fair', '2026-11-01T10:00:00Z', '2026-11-01T18:00:00Z'),
        (2, 'Demo Fair', '2026-11-21T10:00:00Z', NULL);
      ${FAIL_TRIGGER}` },
    { slug: "acme", users: [ACME], seedSql: `
      INSERT INTO items (id, name, price_cents, stock) VALUES (1, 'Acme Mug', 900, 20), (2, 'Acme Bowl', 1200, 8);` },
  ] });
  demo = server.client("demo.localhost");
  acme = server.client("acme.localhost");
  await demo.login(USERS.admin);
  await acme.login(ACME);
});
after(async () => { await server?.stop(); });

const sale = (over = {}) => ({ client_id: randomUUID(), payment_method: "cash", items: [{ item_id: 1, qty: 1 }], ...over });
const stock = (b) => Object.fromEntries(server.query(b, "SELECT id, stock FROM items ORDER BY id").map((r) => [r.id, r.stock]));
const counts = (b) => server.query(b, "SELECT (SELECT count(*) FROM sales) AS sales, (SELECT count(*) FROM sale_items) AS lines")[0];
const snapshot = () => ({ demo: { stock: stock("DB_T1"), ...counts("DB_T1") }, acme: { stock: stock("DB_T2"), ...counts("DB_T2") } });

test("a sale is priced from the vendor's own items; device prices and names are ignored; discount capped", async () => {
  const r = await demo.post("/api/sales", sale({ show_id: 2, discount_cents: 200, discount_label: "Bundle",
    items: [{ item_id: 1, qty: 2, price_cents: 1, name: "Free Tee" }, { item_id: 2, qty: 1, price_cents: 0 }] }));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ["id", "ok", "total_cents"]);
  assert.equal(r.json.total_cents, 2 * 500 + 1500 - 200);
  const [row] = server.query("DB_T1", `SELECT subtotal_cents, discount_cents, discount_label, total_cents, show_id FROM sales WHERE id = ${r.json.id}`);
  assert.deepEqual(row, { subtotal_cents: 2500, discount_cents: 200, discount_label: "Bundle", total_cents: 2300, show_id: 2 });
  assert.deepEqual(server.query("DB_T1", `SELECT item_id, name, qty, price_cents FROM sale_items WHERE sale_id = ${r.json.id} ORDER BY item_id`),
    [{ item_id: 1, name: "Demo Tee", qty: 2, price_cents: 500 }, { item_id: 2, name: "Demo Hat", qty: 1, price_cents: 1500 }]);

  const capped = await demo.post("/api/sales", sale({ discount_cents: 999999, items: [{ item_id: 1, qty: 1 }] }));
  assert.equal(capped.json.total_cents, 0);
  assert.deepEqual(server.query("DB_T1", `SELECT subtotal_cents, discount_cents FROM sales WHERE id = ${capped.json.id}`), [{ subtotal_cents: 500, discount_cents: 500 }]);
});

test("a retried upload returns the original result and writes nothing", async () => {
  const s = sale({ items: [{ item_id: 2, qty: 1 }] });
  const first = await demo.post("/api/sales", s);
  assert.equal(first.status, 200);
  const before = snapshot();
  for (const retry of [s, { ...s, items: [{ item_id: 1, qty: 9 }], payment_method: "zelle" }, { ...s, client_id: s.client_id.toUpperCase() }]) {
    const again = await demo.post("/api/sales", retry);
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { ...first.json, duplicate: true });
  }
  assert.deepEqual(snapshot(), before, "no second sale, no second stock change");
});

test("two uploads of the same sale at the same moment make exactly one sale", async () => {
  const s = sale({ items: [{ item_id: 1, qty: 1 }] });
  const before = counts("DB_T1");
  const results = await Promise.all(Array.from({ length: 5 }, () => demo.post("/api/sales", s)));
  for (const r of results) assert.equal(r.status, 200, r.text);
  assert.equal(new Set(results.map((r) => r.json.id)).size, 1);
  assert.equal(counts("DB_T1").sales, before.sales + 1);
});

test("the same client_id at two vendors is two separate sales, each in its own database at its own prices", async () => {
  const id = randomUUID();
  const before = snapshot();
  const atDemo = await demo.post("/api/sales", sale({ client_id: id, items: [{ item_id: 1, qty: 1 }] }));
  const atAcme = await acme.post("/api/sales", sale({ client_id: id, items: [{ item_id: 1, qty: 1 }] }));
  assert.equal(atDemo.status, 200);
  assert.equal(atAcme.status, 200);
  assert.equal(atAcme.json.duplicate, undefined, "acme's sale is not a duplicate of demo's");
  assert.equal(atDemo.json.total_cents, 500);
  assert.equal(atAcme.json.total_cents, 900, "acme's item 1 at acme's price");
  assert.deepEqual(server.query("DB_T1", `SELECT name FROM sale_items WHERE sale_id = (SELECT id FROM sales WHERE client_id = '${id}')`), [{ name: "Demo Tee" }]);
  assert.deepEqual(server.query("DB_T2", `SELECT name FROM sale_items WHERE sale_id = (SELECT id FROM sales WHERE client_id = '${id}')`), [{ name: "Acme Mug" }]);
  const after = snapshot();
  assert.equal(after.demo.stock[1], before.demo.stock[1] - 1);
  assert.equal(after.acme.stock[1], before.acme.stock[1] - 1);
  assert.equal(after.demo.stock[2], before.demo.stock[2]);
});

test("an item or show only the other vendor has: 422, same as a missing one, and nothing is written", async () => {
  const before = snapshot();
  const answers = [];
  for (const body of [
    sale({ items: [{ item_id: 3, qty: 1 }] }),                                  // demo's item 3
    sale({ items: [{ item_id: 1, qty: 1 }, { item_id: 3, qty: 1 }] }),          // one good line, one foreign
    sale({ items: [{ item_id: 999, qty: 1 }] }),                                // missing everywhere
    sale({ show_id: 2 }),                                                       // demo's running show
    sale({ show_id: 999 }),
  ]) {
    const r = await acme.post("/api/sales", body);
    assert.equal(r.status, 422, JSON.stringify(body));
    answers.push(r.text);
  }
  assert.equal(new Set(answers).size, 1, "every case gives the identical answer");
  assert.deepEqual(JSON.parse(answers[0]), NOT_IN_SHOP);
  assert.deepEqual(snapshot(), before);
});

test("malformed sales get 400 and write nothing", async () => {
  const before = snapshot();
  const bad = [
    sale({ client_id: "not-a-uuid" }), sale({ client_id: 12345 }), sale({ client_id: "" }),
    sale({ payment_method: "card" }), sale({ items: [] }), sale({ items: "1" }),
    ...[0, -1, 1.5, "2", null, 10001].map((qty) => sale({ items: [{ item_id: 1, qty }] })),
    sale({ items: [{ item_id: "1", qty: 1 }] }), sale({ items: [{ qty: 1 }] }), sale({ items: [null] }),
    sale({ items: Array.from({ length: 101 }, () => ({ item_id: 1, qty: 1 })) }),
    sale({ show_id: "2" }), sale({ show_id: 0 }), sale({ discount_cents: -5 }), sale({ discount_cents: 1.5 }),
    sale({ created_at: "yesterday" }), sale({ created_at: 1732000000000 }),
  ];
  for (const body of bad) assert.equal((await demo.post("/api/sales", body)).status, 400, JSON.stringify(body).slice(0, 120));
  assert.deepEqual(snapshot(), before);
});

test("a sale that fails halfway leaves nothing behind (one atomic batch), and a retry then succeeds once", async () => {
  const before = snapshot();
  const s = sale({ items: [{ item_id: 1, qty: 1 }, { item_id: 2, qty: 4242 }] }); // the trigger aborts line 2
  const r = await demo.post("/api/sales", s);
  assert.equal(r.status, 500);
  assert.deepEqual(snapshot(), before, "no sale row, no first line, no stock change");
  assert.deepEqual(server.query("DB_T1", `SELECT count(*) AS n FROM sales WHERE client_id = '${s.client_id}'`), [{ n: 0 }]);
  server.query("DB_T1", "DROP TRIGGER fail_line");
  try {
    const ok = await demo.post("/api/sales", { ...s, items: [{ item_id: 1, qty: 1 }, { item_id: 2, qty: 2 }] });
    assert.equal(ok.status, 200);
    assert.equal((await demo.post("/api/sales", s)).json.duplicate, true);
    const after = snapshot();
    assert.equal(after.demo.sales, before.demo.sales + 1);
    assert.equal(after.demo.stock[1], before.demo.stock[1] - 1);
    assert.equal(after.demo.stock[2], before.demo.stock[2] - 2);
  } finally { server.query("DB_T1", FAIL_TRIGGER); }
});

test("mass assignment: vendor fields and server-computed values in the body change nothing", async () => {
  const r = await acme.post("/api/sales", sale({ tenant_id: 1, slug: "demo", total_cents: 1, subtotal_cents: 1, voided: 1, id: 1,
    items: [{ item_id: 2, qty: 1, tenant_id: 1, price_cents: 1 }] }));
  assert.equal(r.status, 200);
  assert.deepEqual(server.query("DB_T2", `SELECT total_cents, subtotal_cents, voided FROM sales WHERE id = ${r.json.id}`),
    [{ total_cents: 1200, subtotal_cents: 1200, voided: 0 }]);
});

test("voiding a sale id only demo has: 404 like a missing id, and demo's sale stays", async () => {
  const demoSales = server.query("DB_T1", "SELECT id FROM sales ORDER BY id").map((r) => r.id);
  const acmeMax = server.query("DB_T2", "SELECT max(id) AS m FROM sales")[0].m;
  const foreign = demoSales.find((id) => id > acmeMax);
  assert.ok(foreign, "demo has a sale id acme doesn't");
  const r1 = await acme.post(`/api/sales/${foreign}/void`, {});
  const r2 = await acme.post("/api/sales/99999/void", {});
  assert.equal(r1.status, 404);
  assert.equal(r1.text, r2.text);
  assert.deepEqual(server.query("DB_T1", `SELECT voided FROM sales WHERE id = ${foreign}`), [{ voided: 0 }]);
});

test("voiding a sale id both vendors have voids only the caller's own, and restores only its own stock", async () => {
  const before = snapshot();
  const r = await acme.post("/api/sales/1/void", {});
  assert.equal(r.status, 200);
  assert.deepEqual(server.query("DB_T2", "SELECT voided FROM sales WHERE id = 1"), [{ voided: 1 }]);
  assert.deepEqual(server.query("DB_T1", "SELECT voided FROM sales WHERE id = 1"), [{ voided: 0 }]);
  const after = snapshot();
  assert.deepEqual(after.demo, before.demo);
  assert.ok(after.acme.stock[1] > before.acme.stock[1] || after.acme.stock[2] > before.acme.stock[2]);
});

test("lists, summaries and the sales export only ever show the caller's own sales", async () => {
  const unassigned = (await acme.get("/api/sales/unassigned")).json;
  assert.ok(unassigned.length > 0);
  for (const s of unassigned) assert.doesNotMatch(s.summary, /Demo/);
  assert.deepEqual((await acme.get("/api/shows/2/sales")).json, [], "demo's show 2 has no sales at acme");
  const summary = (await acme.get("/api/shows/2/summary")).json;
  assert.deepEqual(summary, { by_payment: [], by_register: [], by_item: [], discount_cents: 0 });
  const csv = (await acme.get("/api/export")).text;
  assert.match(csv, /Acme/);
  assert.doesNotMatch(csv, /Demo/);
  assert.doesNotMatch((await demo.get("/api/export")).text, /Acme/);
});
