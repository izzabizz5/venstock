// All API routes live here: /api/items, /api/shows, /api/sales, /api/settings, /api/export,
// plus /api/auth (log in / sign up) and /api/users (admins). Everything except /api/auth needs a full login.
import { authRoutes, userRoutes, currentSession } from "./lib/auth.js";
import { validateRestock } from "./lib/validate.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);

const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const csvResponse = (rows, filename) =>
  new Response(rows.join("\n"), {
    headers: {
      "content-type": "text/csv",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });

// Settings the app falls back to when nothing has been saved yet.
const DEFAULT_SETTINGS = {
  registers: 3,
  // Bundle deals, always on: buy `qty` items priced `unit_price_cents`, get `off_cents` off.
  // New vendors start with none; they add their own on the Items screen.
  deals: [],
};

// Called by src/worker.js for every /api request; route = the path segments after /api.
export async function handleApi({ request, env, params }) {
  const db = env.DB;
  const url = new URL(request.url);
  const [a, b, c] = params.route || [];
  const m = request.method;
  const body = m === "POST" || m === "PUT" ? await request.json().catch(() => ({})) : {};

  try {
    // ---------- LOGIN ----------
    if (a === "auth") return await authRoutes({ db, request, b, c, m, body });
    const sess = await currentSession(db, request);
    if (!sess || !sess.mfa_ok) return fail("Please log in", 401);
    if (a === "users") {
      if (!sess.is_admin) return fail("Only admins can manage who logs in.", 403);
      return await userRoutes({ db, b, c, m, body, sess });
    }

    // ---------- ITEMS ----------
    if (a === "items") {
      if (!b && m === "GET") {
        const where = url.searchParams.get("all") ? "" : "WHERE active = 1";
        const { results } = await db.prepare(`SELECT * FROM items ${where} ORDER BY id`).all();
        return json(results);
      }
      if (!b && m === "POST") {
        const name = str(body.name);
        if (!name) return fail("Name required");
        const r = await db
          .prepare("INSERT INTO items (name, category, sku, price_cents, stock) VALUES (?,?,?,?,?)")
          .bind(name, str(body.category), str(body.sku), int(body.price_cents), int(body.stock))
          .run();
        return json({ id: r.meta.last_row_id });
      }

      // Bulk import from CSV (parsed in the browser). Matches existing items by SKU,
      // then by name+category; updates them, otherwise adds new ones.
      // mode "set": stock becomes the CSV number. mode "add": CSV number is added to stock.
      if (b === "import" && m === "POST") {
        const rows = Array.isArray(body.rows) ? body.rows : [];
        if (!rows.length) return fail("No rows to import");
        if (rows.length > 2000) return fail("Too many rows (max 2000 at once)");
        const addMode = body.mode === "add";
        const { results: existing } = await db.prepare("SELECT * FROM items").all();
        const key = (name, cat) => `${name.toLowerCase()}|${cat.toLowerCase()}`;
        const bySku = new Map(existing.filter((i) => i.sku).map((i) => [i.sku.toLowerCase(), i]));
        const byName = new Map(existing.map((i) => [key(i.name, i.category), i]));

        const stmts = [];
        const inserts = []; // new items, kept in file order so the sell screen matches the sheet
        let added = 0, updated = 0, skipped = 0;
        for (const raw of rows) {
          const name = str(raw.name);
          if (!name) { skipped++; continue; }
          const row = {
            name,
            category: str(raw.category),
            sku: str(raw.sku),
            price_cents: raw.price_cents == null ? null : Math.max(0, int(raw.price_cents)),
            stock: raw.stock == null ? null : int(raw.stock),
          };
          // SKU wins. Fall back to name + category only when the SKUs don't contradict each other,
          // so two different SKUs that share a name stay two separate items.
          const nameMatch = byName.get(key(row.name, row.category));
          const skuClash = nameMatch && row.sku && nameMatch.sku && nameMatch.sku.toLowerCase() !== row.sku.toLowerCase();
          const match = (row.sku && bySku.get(row.sku.toLowerCase())) || (skuClash ? null : nameMatch);
          if (match && match.isNew) {
            // same item listed twice in this file: merge into the pending insert
            if (row.price_cents != null) match.price_cents = row.price_cents;
            if (row.stock != null) match.stock = addMode ? match.stock + row.stock : row.stock;
            continue;
          }
          if (match) {
            const stock = row.stock == null ? match.stock : addMode ? match.stock + row.stock : row.stock;
            const price = row.price_cents == null ? match.price_cents : row.price_cents;
            stmts.push(
              db.prepare("UPDATE items SET name=?, category=?, sku=?, price_cents=?, stock=?, active=1 WHERE id=?")
                .bind(row.name, row.category, row.sku || match.sku, price, stock, match.id)
            );
            Object.assign(match, { stock, price_cents: price }); // later duplicate rows build on this
            updated++;
          } else {
            const fresh = { ...row, isNew: true, price_cents: row.price_cents ?? 0, stock: row.stock ?? 0 };
            inserts.push(fresh);
            byName.set(key(row.name, row.category), fresh);
            if (row.sku) bySku.set(row.sku.toLowerCase(), fresh);
            added++;
          }
        }
        for (const r of inserts) {
          stmts.push(
            db.prepare("INSERT INTO items (name, category, sku, price_cents, stock) VALUES (?,?,?,?,?)")
              .bind(r.name, r.category, r.sku, r.price_cents, r.stock)
          );
        }
        for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
        return json({ added, updated, skipped });
      }

      // Restock: add quantities to several items at once.
      // Restock: add quantities to several items at once, all or nothing. Ids and quantities must be JSON whole
      // numbers above zero (no strings, negatives or fractions); one bad entry, or an id that doesn't exist, refuses
      // the whole request. At most MAX_RESTOCK_ITEMS (src/lib/validate.js), so it is always one atomic D1 batch (D1 also allows at most
      // 100 bound parameters, which the existence check uses). Lowering a count is done by editing the item.
      if (b === "restock" && m === "POST") {
        const v = validateRestock(body);
        if (v.error) return fail(v.error);
        const raw = v.items;
        const ids = [...new Set(raw.map((i) => i.id))];
        const { results: found } = await db
          .prepare(`SELECT id FROM items WHERE id IN (${ids.map(() => "?").join(",")})`)
          .bind(...ids)
          .all();
        if (found.length !== ids.length) return fail("Not found", 404);
        await db.batch(raw.map((i) => db.prepare("UPDATE items SET stock = stock + ? WHERE id=?").bind(i.qty, i.id)));
        return json({ ok: true, count: raw.length });
      }

      if (b === "export" && m === "GET") {
        const { results } = await db.prepare("SELECT * FROM items ORDER BY id").all();
        return csvResponse(
          [
            "name,category,sku,price,stock,active",
            ...results.map((i) =>
              [csvCell(i.name), csvCell(i.category), csvCell(i.sku), (i.price_cents / 100).toFixed(2), i.stock, i.active ? "yes" : "no"].join(",")
            ),
          ],
          "items.csv"
        );
      }

      if (b && m === "PUT") {
        const name = str(body.name);
        if (!name) return fail("Name required");
        await db
          .prepare("UPDATE items SET name=?, category=?, sku=?, price_cents=?, stock=?, active=? WHERE id=?")
          .bind(name, str(body.category), str(body.sku), int(body.price_cents), int(body.stock), body.active ? 1 : 0, int(b))
          .run();
        return json({ ok: true });
      }
    }

    // ---------- SETTINGS ----------
    if (a === "settings") {
      if (!b && m === "GET") {
        const { results } = await db.prepare("SELECT key, value FROM settings").all();
        const out = { ...DEFAULT_SETTINGS };
        for (const r of results) {
          try { out[r.key] = JSON.parse(r.value); } catch {}
        }
        // deals saved in the old category format don't apply any more; fall back to the defaults
        if (!Array.isArray(out.deals) || out.deals.some((d) => d.unit_price_cents == null)) out.deals = DEFAULT_SETTINGS.deals;
        return json(out);
      }
      if (!b && m === "PUT") {
        const stmts = [];
        if ("registers" in body) {
          const n = Math.min(20, Math.max(1, int(body.registers, 3)));
          stmts.push(db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('registers', ?)").bind(JSON.stringify(n)));
        }
        if ("deals" in body) {
          const deals = (Array.isArray(body.deals) ? body.deals : [])
            .map((d) => ({ qty: int(d.qty), unit_price_cents: int(d.unit_price_cents), off_cents: int(d.off_cents) }))
            .filter((d) => d.qty >= 2 && d.unit_price_cents > 0 && d.off_cents > 0 && d.off_cents < d.qty * d.unit_price_cents);
          stmts.push(db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('deals', ?)").bind(JSON.stringify(deals)));
        }
        if (stmts.length) await db.batch(stmts);
        return json({ ok: true });
      }
    }

    // ---------- SHOWS ----------
    if (a === "shows" && b === "upcoming") {
      // Shows entered ahead of time. Times are just for reference: shows are started and ended by hand.
      const id = int(c);
      const fields = () => {
        const name = str(body.name);
        const date = str(body.show_date, 10);
        const start = str(body.start_time, 5);
        const end = str(body.end_time, 5);
        if (!name) return { error: "Show name required" };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Pick a date" };
        if ((start && !/^\d{2}:\d{2}$/.test(start)) || (end && !/^\d{2}:\d{2}$/.test(end))) return { error: "Bad time" };
        if (start && end && end <= start) return { error: "The end time needs to be after the start time" };
        return { values: [name, date, start, end] };
      };
      if (!c && m === "GET") {
        const { results } = await db
          .prepare("SELECT * FROM upcoming_shows ORDER BY show_date, start_time = '', start_time, id")
          .all();
        return json(results);
      }
      if (!c && m === "POST") {
        const f = fields();
        if (f.error) return fail(f.error);
        const r = await db
          .prepare("INSERT INTO upcoming_shows (name, show_date, start_time, end_time) VALUES (?,?,?,?)")
          .bind(...f.values)
          .run();
        return json({ id: r.meta.last_row_id });
      }
      if (id && m === "PUT") {
        const f = fields();
        if (f.error) return fail(f.error);
        await db
          .prepare("UPDATE upcoming_shows SET name=?, show_date=?, start_time=?, end_time=? WHERE id=?")
          .bind(...f.values, id)
          .run();
        return json({ ok: true });
      }
      if (id && m === "DELETE") {
        await db.prepare("DELETE FROM upcoming_shows WHERE id=?").bind(id).run();
        return json({ ok: true });
      }
      // Start it: ends whatever show is running, opens this one, and takes it off the upcoming list.
      if (id && params.route[3] === "start" && m === "POST") {
        const up = await db.prepare("SELECT * FROM upcoming_shows WHERE id=?").bind(id).first();
        if (!up) return fail("That show was already started or removed", 404);
        const now = new Date().toISOString();
        await db.batch([
          db.prepare("UPDATE shows SET ended_at = ? WHERE ended_at IS NULL").bind(now),
          db.prepare("INSERT INTO shows (name, started_at) VALUES (?,?)").bind(up.name, now),
          db.prepare("DELETE FROM upcoming_shows WHERE id=?").bind(id),
        ]);
        return json({ ok: true });
      }
    }

    if (a === "shows") {
      if (!b && m === "GET") {
        const { results } = await db.prepare("SELECT * FROM shows ORDER BY id DESC LIMIT 50").all();
        return json(results);
      }
      if (!b && m === "POST") {
        const name = str(body.name);
        if (!name) return fail("Show name required");
        // only one show open at a time
        await db
          .prepare("UPDATE shows SET ended_at = ? WHERE ended_at IS NULL")
          .bind(new Date().toISOString())
          .run();
        const r = await db
          .prepare("INSERT INTO shows (name, started_at) VALUES (?,?)")
          .bind(name, new Date().toISOString())
          .run();
        return json({ id: r.meta.last_row_id });
      }
      if (b === "active" && m === "GET") {
        const row = await db
          .prepare("SELECT * FROM shows WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1")
          .first();
        return json(row || null);
      }
      if (b && c === "end" && m === "POST") {
        await db
          .prepare("UPDATE shows SET ended_at=? WHERE id=? AND ended_at IS NULL")
          .bind(new Date().toISOString(), int(b))
          .run();
        return json({ ok: true });
      }
      if (b && c === "summary" && m === "GET") {
        const id = int(b);
        const [byPay, byReg, byItem, disc] = await db.batch([
          db.prepare(
            `SELECT payment_method, COUNT(*) AS sales, COALESCE(SUM(total_cents),0) AS total_cents
             FROM sales WHERE show_id=? AND voided=0 GROUP BY payment_method`
          ).bind(id),
          db.prepare(
            `SELECT register, COUNT(*) AS sales, COALESCE(SUM(total_cents),0) AS total_cents
             FROM sales WHERE show_id=? AND voided=0 GROUP BY register ORDER BY register`
          ).bind(id),
          db.prepare(
            `SELECT si.name, SUM(si.qty) AS qty, SUM(si.qty*si.price_cents) AS total_cents
             FROM sale_items si JOIN sales s ON s.id=si.sale_id
             WHERE s.show_id=? AND s.voided=0 GROUP BY si.item_id, si.name ORDER BY qty DESC`
          ).bind(id),
          db.prepare(
            `SELECT COALESCE(SUM(discount_cents),0) AS discount_cents FROM sales WHERE show_id=? AND voided=0`
          ).bind(id),
        ]);
        return json({
          by_payment: byPay.results,
          by_register: byReg.results,
          by_item: byItem.results,
          discount_cents: disc.results[0]?.discount_cents || 0,
        });
      }
      if (b && c === "sales" && m === "GET") {
        const { results } = await db
          .prepare(
            `SELECT s.*, (SELECT group_concat(qty || '× ' || name, ', ') FROM sale_items WHERE sale_id=s.id) AS summary
             FROM sales s WHERE show_id=? ORDER BY s.id DESC LIMIT 300`
          )
          .bind(int(b))
          .all();
        return json(results);
      }
    }

    // ---------- SALES ----------
    if (a === "sales") {
      // sales made while no show was running
      if (b === "unassigned" && m === "GET") {
        const { results } = await db
          .prepare(
            `SELECT s.*, (SELECT group_concat(qty || '× ' || name, ', ') FROM sale_items WHERE sale_id=s.id) AS summary
             FROM sales s WHERE show_id IS NULL ORDER BY s.id DESC LIMIT 300`
          )
          .all();
        return json(results);
      }
      if (!b && m === "POST") {
        const { client_id, show_id, payment_method, items, created_at } = body;
        if (!client_id || !["cash", "venmo", "zelle"].includes(payment_method)) return fail("Bad sale");
        if (!Array.isArray(items) || !items.length) return fail("No items");
        const dup = await db.prepare("SELECT id FROM sales WHERE client_id=?").bind(client_id).first();
        if (dup) return json({ id: dup.id, duplicate: true }); // safe to retry

        const lines = items.map((i) => ({
          item_id: int(i.item_id),
          name: str(i.name),
          qty: Math.max(1, int(i.qty, 1)),
          price_cents: Math.max(0, int(i.price_cents)),
        }));
        const subtotal = lines.reduce((t, l) => t + l.qty * l.price_cents, 0);
        const discount = Math.min(subtotal, Math.max(0, int(body.discount_cents)));
        const stmts = [
          db
            .prepare(
              `INSERT INTO sales (client_id, show_id, payment_method, total_cents, created_at,
                                  register, notes, subtotal_cents, discount_cents, discount_label)
               VALUES (?,?,?,?,?,?,?,?,?,?)`
            )
            .bind(
              client_id,
              show_id ? int(show_id) : null,
              payment_method,
              subtotal - discount,
              created_at || new Date().toISOString(),
              str(body.register, 50),
              str(body.notes, 1000),
              subtotal,
              discount,
              discount ? str(body.discount_label, 100) : ""
            ),
        ];
        for (const l of lines) {
          stmts.push(
            db
              .prepare(
                "INSERT INTO sale_items (sale_id, item_id, name, qty, price_cents) VALUES ((SELECT id FROM sales WHERE client_id=?),?,?,?,?)"
              )
              .bind(client_id, l.item_id, l.name, l.qty, l.price_cents),
            db.prepare("UPDATE items SET stock = stock - ? WHERE id=?").bind(l.qty, l.item_id)
          );
        }
        await db.batch(stmts);
        return json({ ok: true });
      }
      if (b && c === "void" && m === "POST") {
        const sale = await db.prepare("SELECT * FROM sales WHERE id=?").bind(int(b)).first();
        if (!sale) return fail("Not found", 404);
        if (sale.voided) return json({ ok: true });
        const { results } = await db
          .prepare("SELECT item_id, qty FROM sale_items WHERE sale_id=?")
          .bind(sale.id)
          .all();
        await db.batch([
          db.prepare("UPDATE sales SET voided=1 WHERE id=?").bind(sale.id),
          ...results.map((r) => db.prepare("UPDATE items SET stock = stock + ? WHERE id=?").bind(r.qty, r.item_id)),
        ]);
        return json({ ok: true });
      }
    }

    // ---------- SALES CSV EXPORT ----------
    if (a === "export" && m === "GET") {
      const showId = url.searchParams.get("show_id");
      const { results } = await db
        .prepare(
          `SELECT s.id, COALESCE(sh.name,'') AS show_name, s.created_at, s.payment_method, s.register,
                  s.subtotal_cents, s.discount_cents, s.discount_label, s.total_cents, s.notes,
                  si.name AS item, si.qty, si.price_cents, s.voided
           FROM sales s
           JOIN sale_items si ON si.sale_id = s.id
           LEFT JOIN shows sh ON sh.id = s.show_id
           ${showId ? "WHERE s.show_id = ?" : ""}
           ORDER BY s.id`
        )
        .bind(...(showId ? [int(showId)] : []))
        .all();
      const d = (cents) => (cents / 100).toFixed(2);
      return csvResponse(
        [
          "sale_id,show,time,register,payment,item,qty,price,sale_subtotal,discount,discount_type,sale_total,notes,voided",
          ...results.map((r) =>
            [
              r.id, csvCell(r.show_name), r.created_at, csvCell(r.register), r.payment_method,
              csvCell(r.item), r.qty, d(r.price_cents), d(r.subtotal_cents), d(r.discount_cents),
              csvCell(r.discount_label), d(r.total_cents), csvCell(r.notes), r.voided ? "yes" : "",
            ].join(",")
          ),
        ],
        "sales.csv"
      );
    }

    return fail("Not found", 404);
  } catch (e) {
    return fail(String(e.message || e), 500);
  }
}
