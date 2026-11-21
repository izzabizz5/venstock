// public/sync.js: which upload answers mark a sale failed, the upload pass, the service worker's shell strategy and
// the failed-sales CSV. Fake fetch and cache; no browser, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../public/sync.js";

const { classifyUpload, uploadPending, shellFetch, failedCsv } = globalThis.VenstockSync;

test("only 400 and 422 mark a sale failed; 2xx is done; everything else retries", () => {
  for (const s of [200, 201, 204]) assert.equal(classifyUpload(s), "done", String(s));
  for (const s of [400, 422]) assert.equal(classifyUpload(s), "failed", String(s));
  // 403 (suspended, or refused as a cross-site request) and 415 (wrong content type) never mark a sale failed.
  for (const s of [0, 401, 403, 404, 405, 408, 409, 413, 415, 429, 500, 502, 503, 504]) assert.equal(classifyUpload(s), "retry", String(s));
});

const sale = (n) => ({ client_id: `id-${n}`, items: [{ qty: 1, name: `item ${n}`, price_cents: 100 }], created_at: "2026-11-21T10:00:00.000Z", payment_method: "cash" });

test("upload pass: uploaded sales leave the queue, refused ones move to failed with the reason, order kept", async () => {
  const answers = { "id-1": { status: 200 }, "id-2": { status: 422, error: "This sale refers to an item or show that isn't in this shop" },
    "id-3": { status: 400, error: "No items" }, "id-4": { status: 200 } };
  const seen = [];
  const r = await uploadPending([sale(1), sale(2), sale(3), sale(4)], async (s) => { seen.push(s.client_id); return answers[s.client_id]; }, () => "T");
  assert.deepEqual(seen, ["id-1", "id-2", "id-3", "id-4"]);
  assert.deepEqual(r.pending, []);
  assert.equal(r.stopped, null);
  assert.deepEqual(r.failed.map((f) => [f.sale.client_id, f.status, f.error, f.at]), [
    ["id-2", 422, "This sale refers to an item or show that isn't in this shop", "T"], ["id-3", 400, "No items", "T"]]);
});

test("upload pass: the first retry answer stops the pass and keeps that sale and everything after it queued", async () => {
  for (const status of [0, 401, 403, 404, 409, 415, 429, 500, 503]) {
    const seen = [];
    const r = await uploadPending([sale(1), sale(2), sale(3)], async (s) => { seen.push(s.client_id); return s.client_id === "id-2" ? { status } : { status: 200 }; });
    assert.deepEqual(r.pending.map((s) => s.client_id), ["id-2", "id-3"], String(status));
    assert.deepEqual(r.failed, [], `${status} never marks a sale failed`);
    assert.equal(r.stopped, status);
    assert.deepEqual(seen, ["id-1", "id-2"], "nothing after the stop is tried");
  }
});

test("upload pass: a thrown error (no connection) counts as offline", async () => {
  const r = await uploadPending([sale(1)], async () => { throw new TypeError("fetch failed"); });
  assert.equal(r.stopped, 0);
  assert.equal(r.pending.length, 1);
});

// A cache that records puts; match() by URL string.
function fakeCache(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    puts: [],
    async match(req) { return store.get(typeof req === "string" ? req : req.url) || undefined; },
    async put(req, res) { this.puts.push([req.url ?? req, res.status]); store.set(req.url ?? req, res); },
  };
}
const req = (path = "/app.js") => ({ url: path });
const page = (status, body = `status ${status}`) => new Response(body, { status });

test("shell: a 200 is cached and shown", async () => {
  const cache = fakeCache();
  const res = await shellFetch(req(), { fetch: async () => page(200, "fresh"), cache });
  assert.equal(await res.text(), "fresh");
  assert.deepEqual(cache.puts, [["/app.js", 200]]);
});

test("shell: 500, 502, 503 and 504 show the cached copy, and the error is never cached", async () => {
  for (const status of [500, 502, 503, 504]) {
    const cache = fakeCache({ "/app.js": page(200, "cached app") });
    const res = await shellFetch(req(), { fetch: async () => page(status), cache });
    assert.equal(res.status, 200, String(status));
    assert.equal(await res.text(), "cached app");
    assert.deepEqual(cache.puts, []);
  }
});

test("shell: with nothing cached, a 503 is shown as it is (the 'being set up' page)", async () => {
  const res = await shellFetch(req(), { fetch: async () => page(503, "This shop is being set up"), cache: fakeCache() });
  assert.equal(res.status, 503);
});

test("shell: 404 and 403 are shown as they are, even with a cached copy, and never cached", async () => {
  for (const status of [404, 403, 401, 400]) {
    const cache = fakeCache({ "/app.js": page(200, "cached app") });
    const res = await shellFetch(req(), { fetch: async () => page(status), cache });
    assert.equal(res.status, status);
    assert.deepEqual(cache.puts, []);
  }
});

test("shell: offline uses the cached copy, or the cached app page", async () => {
  const offline = async () => { throw new TypeError("Failed to fetch"); };
  assert.equal(await (await shellFetch(req(), { fetch: offline, cache: fakeCache({ "/app.js": page(200, "a") }) })).text(), "a");
  assert.equal(await (await shellFetch(req("/somewhere"), { fetch: offline, cache: fakeCache({ "/": page(200, "home") }) })).text(), "home");
});

test("failed-sales CSV: one row per sale with the reason; quotes escaped", () => {
  const csv = failedCsv([{ sale: { ...sale(1), notes: 'said "hi"', register: "R1", discount_cents: 50 }, error: "No items", at: "T" }]);
  const [head, row] = csv.split("\n");
  assert.equal(head, "time,register,payment,items,device_total,discount,notes,reason,sale_id");
  assert.equal(row, '2026-11-21T10:00:00.000Z,"R1",cash,"1x item 1",0.50,0.50,"said ""hi""","No items",id-1');
});
