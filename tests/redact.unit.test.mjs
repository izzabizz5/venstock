// src/lib/redact.js: what a support session's browser may receive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactValue, redactForSupport } from "../src/lib/redact.js";

test("secret keys are removed at any depth; otpauth links are blanked; everything else stays", () => {
  const input = { email: "a@b.test", password_hash: "pbkdf2$...", nested: [{ totp_secret: "JBSW", invite: "AAAA-BBBB-CCCC", ok: 1 }],
    session_id: "s", token: "t", uri: "otpauth://totp/x?secret=Y", note: "otpauth://totp/x", secret: "z", Code_Hash: "h", name: "Tee" };
  assert.deepEqual(redactValue(input), { email: "a@b.test", nested: [{ ok: 1 }], note: "[redacted]", name: "Tee" });
});

test("JSON responses are rewritten without secrets or Set-Cookie; other responses pass through untouched", async () => {
  const r = await redactForSupport(new Response(JSON.stringify({ invite: "X", email: "e" }), {
    status: 201, headers: { "content-type": "application/json", "set-cookie": "__Host-pos_session=abc", "x-keep": "1" } }));
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { email: "e" });
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal(r.headers.get("x-keep"), "1");
  const csv = new Response("a,b\n1,2", { headers: { "content-type": "text/csv" } });
  assert.equal(await redactForSupport(csv), csv);
});
