// The support link: one use, opened within 60 seconds, never stored or logged in the clear, and no page leaks it
// (or anything else) through a Referer header. The code travels in the URL fragment, which browsers never send to a
// server, and is POSTed as JSON by the vendor page, which removes it from the address bar first (public/app.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, rawRequest, USERS, PLATFORM_ADMIN } from "./harness.mjs";
import { sha256 } from "../src/lib/auth.js";

let server, admin;
before(async () => {
  server = await startServer({ vendors: [{ slug: "demo", users: [USERS.admin] }], platformAdmins: [PLATFORM_ADMIN] });
  admin = server.client("admin.localhost");
  await admin.login(PLATFORM_ADMIN);
});
after(async () => { await server?.stop(); });

const start = async () => {
  const r = await admin.post("/api/platform/support", { slug: "demo", reason: "Testing the support link rules" });
  assert.equal(r.status, 200, r.text);
  return { ...r.json, code: new URL(r.json.url).hash.slice("#support=".length) };
};
const enter = (code) => rawRequest(server.port, { host: "demo.localhost", method: "POST", path: "/api/support/enter", body: { code } });
const ageLink = (id, seconds) => server.query("CONTROL", `UPDATE support_sessions SET created_at = '${new Date(Date.now() - seconds * 1000).toISOString()}' WHERE id = ${id}`);

test("the link says when it stops working: 60 seconds after it was made", async () => {
  const s = await start();
  assert.ok(Math.abs(s.link_expires_at - (Date.now() + 60_000)) < 5_000);
  assert.ok(s.expires_at - s.link_expires_at > 28 * 60_000, "the session itself lasts 30 minutes");
  assert.match(s.url, /^http:\/\/demo\.localhost:\d+\/#support=/, "the code is in the fragment, never the path or query");
});

test("a link older than 60 seconds is refused (and the refusal is audited); one just inside the window works, once", async () => {
  const old = await start();
  ageLink(old.id, 61);
  const r = await enter(old.code);
  assert.equal(r.status, 400);
  assert.equal(r.headers["set-cookie"], undefined);
  assert.match(server.query("CONTROL", "SELECT detail FROM audit_log ORDER BY id DESC LIMIT 1")[0].detail, /link older than 60 s/);

  const fresh = await start();
  ageLink(fresh.id, 55);
  assert.equal((await enter(fresh.code)).status, 200);
  assert.equal((await enter(fresh.code)).status, 400, "single use");
});

test("the code and the cookie token are stored only as hashes, and appear in neither the server log nor the audit log", async () => {
  const s = await start();
  const r = await enter(s.code);
  const token = [].concat(r.headers["set-cookie"])[0].split(";")[0].split("=")[1];
  await rawRequest(server.port, { host: "demo.localhost", path: "/api/items", headers: { cookie: `__Host-pos_support=${token}` } });
  const row = server.query("CONTROL", `SELECT * FROM support_sessions WHERE id = ${s.id}`)[0];
  assert.equal(row.code_hash, null, "the code's hash is cleared once used");
  assert.equal(row.token_hash, await sha256(token));
  const everything = JSON.stringify([server.query("CONTROL", "SELECT * FROM support_sessions"), server.query("CONTROL", "SELECT * FROM audit_log")]);
  for (const secret of [s.code, token]) {
    assert.ok(!everything.includes(secret), "not in the control database in the clear");
    assert.ok(!server.log().includes(secret), "not in the server's request log");
  }
});

test("every response says Referrer-Policy: no-referrer: vendor app, API, the link exchange, admin page, errors", async () => {
  const s = await start();
  for (const [host, method, path, body] of [["demo.localhost", "GET", "/"], ["demo.localhost", "GET", "/app.js"], ["demo.localhost", "GET", "/api/items"],
    ["demo.localhost", "POST", "/api/support/enter", { code: s.code }], ["admin.localhost", "GET", "/"], ["admin.localhost", "GET", "/api/auth/me"],
    ["nosuch.localhost", "GET", "/"], ["demo.localhost", "POST", "/api/items", undefined]]) {
    const r = await rawRequest(server.port, { host, method, path, body, headers: method === "POST" && !body ? { "content-type": "text/plain" } : {} });
    assert.equal(r.headers["referrer-policy"], "no-referrer", `${host}${path} (${r.status})`);
  }
  assert.match((await rawRequest(server.port, { host: "demo.localhost", path: "/" })).text, /<meta name="referrer" content="no-referrer">/);
});
