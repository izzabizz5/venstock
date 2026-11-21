// recordSale (src/lib/sales.js) with a fake D1, for what a local server can't produce on demand: two uploads of the
// same sale interleaving between the duplicate check and the insert. The HTTP behaviour is in sales.isolation.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordSale } from "../src/lib/sales.js";

const UUID = "3f2b8c1e-9d4a-4c7b-8e2f-1a2b3c4d5e6f";
const sale = { client_id: UUID, payment_method: "cash", items: [{ item_id: 1, qty: 2 }] };

// The other upload commits right after our duplicate check: the check sees nothing, our insert hits UNIQUE.
function racingDb({ batchError = new Error("D1_ERROR: UNIQUE constraint failed: sales.client_id: SQLITE_CONSTRAINT") } = {}) {
  let checks = 0;
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      let args = [];
      return {
        bind(...a) { args = a; return this; },
        async first() {
          calls.push(sql);
          if (/FROM sales WHERE client_id/.test(sql)) return checks++ === 0 ? null : { id: 41, total_cents: 1000 };
          return { id: 1 };
        },
        async all() { calls.push(sql); return { results: [{ id: 1, name: "Tee", price_cents: 500 }] }; },
        async run() { throw new Error("not used"); },
      };
    },
    async batch(stmts) { calls.push(`batch(${stmts.length})`); throw batchError; },
  };
  return db;
}

test("a concurrent duplicate that wins the race is answered like a retry, with the winner's result", async () => {
  const db = racingDb();
  const r = await recordSale(db, sale);
  assert.deepEqual(r, { status: 200, body: { ok: true, id: 41, total_cents: 1000, duplicate: true } });
  assert.deepEqual(db.calls.filter((c) => c.startsWith("batch")), ["batch(3)"], "one batch attempt: sale + line + stock");
});

test("any other batch failure is not mistaken for a duplicate", async () => {
  const db = racingDb({ batchError: new Error("D1_ERROR: disk I/O error") });
  await assert.rejects(recordSale(db, sale), /disk I\/O error/);
});

test("validation happens before any database call", async () => {
  const db = racingDb();
  const r = await recordSale(db, { ...sale, client_id: "nope" });
  assert.equal(r.status, 400);
  assert.deepEqual(db.calls, []);
});
