// The lockdown against a real local server: unexpected errors give a generic answer; the details (method, path,
// vendor, error) go to the server log and never to the browser; request bodies never go to the log.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer, rawRequest, USERS } from "./harness.mjs";

const GENERIC = { error: "Something went wrong" };
const SECRET_NOTE = "SECRET-NOTE-7f3a do not log";
let server, demo;

before(async () => {
  server = await startServer({ vendors: [{ slug: "demo", users: [USERS.admin], seedSql: `
    INSERT INTO items (id, name, price_cents, stock) VALUES (1, 'Tee', 500, 10);
    CREATE TRIGGER internal_failure BEFORE INSERT ON sale_items BEGIN SELECT RAISE(ABORT, 'forced internal failure'); END;` }] });
  demo = server.client("demo.localhost");
  await demo.login(USERS.admin);
});
after(async () => { await server?.stop(); });

const waitForLog = async (re) => {
  for (let i = 0; i < 40 && !re.test(server.log()); i++) await new Promise((r) => setTimeout(r, 50));
  return server.log();
};

test("an internal error in a handler: generic 500 to the browser; method, path, vendor and cause in the log only", async () => {
  const r = await demo.post("/api/sales", { client_id: randomUUID(), payment_method: "cash", notes: SECRET_NOTE, items: [{ item_id: 1, qty: 1 }] });
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, GENERIC);
  assert.doesNotMatch(r.text, /forced|SQLITE|sale_items|trigger|stack/i);
  const log = await waitForLog(/forced internal failure/);
  assert.match(log, /venstock: 500 POST \/api\/sales tenant=1: .*forced internal failure/);
  assert.ok(!log.includes(SECRET_NOTE), "the request body (customer notes) never reaches the log");
  assert.ok(!log.includes(USERS.admin.password), "nor a password");
});

test("the control database failing: generic 500 on the app shell and the API, cause in the log", async () => {
  server.query("CONTROL", "ALTER TABLE tenants RENAME TO tenants_away");
  try {
    // A host this isolate hasn't looked up yet, so the registry cache can't answer for it.
    for (const [path, api] of [["/", false], ["/api/auth/me", true]]) {
      const r = await rawRequest(server.port, { host: "fresh-host.localhost", path });
      assert.equal(r.status, 500, path);
      if (api) assert.deepEqual(r.json, GENERIC);
      else assert.equal(r.text, "Something went wrong");
      assert.doesNotMatch(r.text, /tenants|SQLITE|no such table/i);
    }
    assert.match(await waitForLog(/no such table: tenants/), /venstock: 500 GET fresh-host\.localhost\/.*no such table: tenants/);
  } finally {
    server.query("CONTROL", "ALTER TABLE tenants_away RENAME TO tenants");
  }
});

test("after the errors, the vendor works normally", async () => {
  assert.equal((await demo.get("/api/items")).status, 200);
});
