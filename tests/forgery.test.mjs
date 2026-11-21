// Same-site forgery and cookie tossing against a real local server. A page on a sibling subdomain is "same-site", so
// SameSite=Strict cookies go with its requests; these checks are what stop it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, rawRequest, USERS } from "./harness.mjs";

let server, demo, cookie;
before(async () => {
  server = await startServer({ vendors: [{ slug: "demo", users: [USERS.admin, USERS.staff] }] });
  demo = server.client("demo.localhost");
  await demo.login(USERS.admin);
  cookie = `__Host-pos_session=${demo.cookies["__Host-pos_session"]}`;
});
after(async () => { await server?.stop(); });

const items = () => server.query("DB_T1", "SELECT name FROM items ORDER BY id").map((r) => r.name);
const send = (method, path, headers, body) => rawRequest(server.port, { host: "demo.localhost", method, path, body,
  headers: { cookie, ...headers } });

test("login sets __Host-pos_session: Secure, HttpOnly, SameSite=Strict, Path=/, no Domain", async () => {
  const c = server.client("demo.localhost");
  const r = await c.post("/api/auth/login", { email: USERS.staff.email, password: USERS.staff.password });
  assert.equal(r.status, 200);
  const [set] = [].concat(r.headers["set-cookie"]);
  assert.match(set, /^__Host-pos_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  assert.doesNotMatch(set, /domain/i);
});

test("a write without the JSON content type is refused with 415 and changes nothing", async () => {
  const body = JSON.stringify({ name: "Forged", price_cents: 1, stock: 1 });
  for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
    const r = await send("POST", "/api/items", { "content-type": ct }, body);
    assert.equal(r.status, 415, JSON.stringify(ct));
  }
  assert.equal((await send("DELETE", "/api/users/2", { "content-type": "" })).status, 415);
  assert.deepEqual(items(), []);
  assert.equal(server.query("DB_T1", "SELECT count(*) AS n FROM users")[0].n, 2);
});

test("a JSON write from another site or a sibling subdomain (Sec-Fetch-Site) is refused with 403", async () => {
  for (const site of ["same-site", "cross-site", "none"]) {
    const r = await send("POST", "/api/items", { "sec-fetch-site": site }, { name: "Forged", price_cents: 1, stock: 1 });
    assert.equal(r.status, 403, site);
  }
  assert.deepEqual(items(), []);
});

test("the app's own requests still work: same-origin JSON, and JSON with no Sec-Fetch-Site (older browsers)", async () => {
  assert.equal((await send("POST", "/api/items", { "sec-fetch-site": "same-origin" }, { name: "Mine", price_cents: 1, stock: 1 })).status, 200);
  assert.equal((await send("POST", "/api/items", {}, { name: "Mine too", price_cents: 1, stock: 1 })).status, 200);
  assert.deepEqual(items(), ["Mine", "Mine too"]);
  assert.equal((await send("GET", "/api/items", { "sec-fetch-site": "cross-site" })).status, 200, "GET changes nothing, so it isn't refused");
});

test("login can't be forged either (no session cookie from a text/plain or cross-site login)", async () => {
  const body = { email: USERS.staff.email, password: USERS.staff.password };
  for (const headers of [{ "content-type": "text/plain" }, { "sec-fetch-site": "same-site" }]) {
    const r = await rawRequest(server.port, { host: "demo.localhost", method: "POST", path: "/api/auth/login", body, headers });
    assert.ok([403, 415].includes(r.status), JSON.stringify(headers));
    assert.equal(r.headers["set-cookie"], undefined);
  }
});

test("only __Host-pos_session is read: the old name doesn't log in, and a tossed cookie doesn't log out", async () => {
  const token = demo.cookies["__Host-pos_session"];
  const me = (c) => rawRequest(server.port, { host: "demo.localhost", path: "/api/auth/me", headers: { cookie: c } });
  assert.equal((await me(`pos_session=${token}`)).status, 401, "a valid token under the old name is ignored");
  assert.equal((await me(`pos_session=tossed; __Host-pos_session=${token}`)).status, 200, "a cookie tossed in first is ignored");
  assert.equal((await me(`__Host-pos_session=${token}; pos_session=tossed`)).status, 200);
});
