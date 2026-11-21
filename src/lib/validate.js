// Pure request validation (no database), so it can be unit-tested without a server.

export const MAX_RESTOCK_QTY = 100000;
export const MAX_RESTOCK_ITEMS = 100;

// body.items = [{ id, qty }, ...]. Returns { items } or { error } (the 400 message). One bad entry refuses the lot.
export function validateRestock(body) {
  const raw = Array.isArray(body?.items) ? body.items : [];
  if (!raw.length) return { error: "Nothing to restock" };
  if (raw.length > MAX_RESTOCK_ITEMS) return { error: `Restock at most ${MAX_RESTOCK_ITEMS} items at once` };
  const wholeAbove0 = (v, max) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max;
  if (!raw.every((i) => i && wholeAbove0(i.id, Number.MAX_SAFE_INTEGER) && wholeAbove0(i.qty, MAX_RESTOCK_QTY))) {
    return { error: `Each restock needs an item and a whole number from 1 to ${MAX_RESTOCK_QTY}` };
  }
  return { items: raw.map((i) => ({ id: i.id, qty: i.qty })) };
}
