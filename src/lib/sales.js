// Records one sale uploaded by a device (rung up there, possibly hours ago and offline), in ONE vendor's database.
//   - Safe to retry: client_id is unique in this database, and a repeat (even two at the same moment) returns the
//     original result without writing anything.
//   - Prices and names come from this vendor's own items; a price changed since the sale was rung up is used as it is
//     now. The device's discount is kept but never more than the subtotal.
//   - Every item (and the show, if any) must exist in this database. Missing and "another vendor's" get the same 422.
//   - The sale, its lines and the stock changes are one batch (one transaction): all of it happens, or none.
// Returns { status, body }.
import { validateSale } from "./validate.js";

export const NOT_IN_SHOP = "This sale refers to an item or show that isn't in this shop";

export async function recordSale(db, body) {
  const v = validateSale(body);
  if (v.error) return { status: 400, body: { error: v.error } };
  const sale = v.sale;
  const original = () => db.prepare("SELECT id, total_cents FROM sales WHERE client_id = ?").bind(sale.client_id).first();
  const repeat = (row) => ({ status: 200, body: { ok: true, id: row.id, total_cents: row.total_cents, duplicate: true } });
  const dup = await original();
  if (dup) return repeat(dup);

  const ids = [...new Set(sale.lines.map((l) => l.item_id))];
  const { results: found } = await db
    .prepare(`SELECT id, name, price_cents FROM items WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all();
  const show = sale.show_id ? await db.prepare("SELECT id FROM shows WHERE id = ?").bind(sale.show_id).first() : true;
  if (found.length !== ids.length || !show) return { status: 422, body: { error: NOT_IN_SHOP } };

  const byId = new Map(found.map((i) => [i.id, i]));
  const lines = sale.lines.map((l) => ({ ...l, name: byId.get(l.item_id).name, price_cents: byId.get(l.item_id).price_cents }));
  const subtotal = lines.reduce((t, l) => t + l.qty * l.price_cents, 0);
  const discount = Math.min(subtotal, sale.discount_cents);
  const total = subtotal - discount;
  const stmts = [
    db.prepare(
      `INSERT INTO sales (client_id, show_id, payment_method, total_cents, created_at,
                          register, notes, subtotal_cents, discount_cents, discount_label)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(sale.client_id, sale.show_id, sale.payment_method, total, sale.created_at,
      sale.register, sale.notes, subtotal, discount, discount ? sale.discount_label : ""),
  ];
  for (const l of lines) {
    stmts.push(
      db.prepare("INSERT INTO sale_items (sale_id, item_id, name, qty, price_cents) VALUES ((SELECT id FROM sales WHERE client_id=?),?,?,?,?)")
        .bind(sale.client_id, l.item_id, l.name, l.qty, l.price_cents),
      db.prepare("UPDATE items SET stock = stock - ? WHERE id=?").bind(l.qty, l.item_id)
    );
  }
  try {
    const [inserted] = await db.batch(stmts);
    return { status: 200, body: { ok: true, id: inserted.meta.last_row_id, total_cents: total } };
  } catch (e) {
    // Two uploads of the same sale at once: the other one won between our check and our insert. Answer like a retry.
    const won = /UNIQUE/i.test(String(e?.message)) ? await original() : null;
    if (won) return repeat(won);
    throw e;
  }
}
