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

export const MAX_SALE_LINES = 100;  // one sale = 1 + 2 statements per line in one atomic D1 batch
export const MAX_SALE_QTY = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const whole = (v, min, max) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// The shape of a sale uploaded by a device. Prices and names are NOT taken from the device: the server reads them from
// the vendor's own items. Returns { sale } or { error } (a 400: the device sent something malformed).
export function validateSale(body) {
  if (!body || typeof body !== "object") return { error: "Bad sale" };
  const { client_id, payment_method, items, show_id, created_at, discount_cents } = body;
  if (typeof client_id !== "string" || !UUID.test(client_id)) return { error: "Bad sale: it needs a valid sale id" };
  if (!["cash", "venmo", "zelle"].includes(payment_method)) return { error: "Bad sale: unknown payment method" };
  if (!Array.isArray(items) || !items.length) return { error: "No items" };
  if (items.length > MAX_SALE_LINES) return { error: `A sale can have at most ${MAX_SALE_LINES} lines` };
  if (!items.every((i) => i && whole(i.item_id, 1, Number.MAX_SAFE_INTEGER) && whole(i.qty, 1, MAX_SALE_QTY))) {
    return { error: `Each line needs an item and a quantity from 1 to ${MAX_SALE_QTY}` };
  }
  if (show_id != null && !whole(show_id, 1, Number.MAX_SAFE_INTEGER)) return { error: "Bad sale: bad show" };
  if (discount_cents != null && !whole(discount_cents, 0, Number.MAX_SAFE_INTEGER)) return { error: "Bad sale: bad discount" };
  let when = new Date().toISOString();
  if (created_at != null) {
    const d = typeof created_at === "string" && created_at.length <= 40 ? new Date(created_at) : null;
    if (!d || Number.isNaN(d.getTime())) return { error: "Bad sale: bad time" };
    when = d.toISOString();
  }
  return {
    sale: {
      client_id: client_id.toLowerCase(),
      payment_method,
      show_id: show_id ?? null,
      created_at: when,
      register: text(body.register, 50),
      notes: text(body.notes, 1000),
      discount_cents: discount_cents ?? 0,
      discount_label: text(body.discount_label, 100),
      lines: items.map((i) => ({ item_id: i.item_id, qty: i.qty })),
    },
  };
}
