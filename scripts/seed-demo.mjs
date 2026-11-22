// Fills the LOCAL vendor "demo" with realistic data so every screen can be looked at: items, shows, upcoming shows,
// bundle deals and a day of sales. Local only, always: it refuses --remote and any argument that names a database,
// before anything is opened. It never touches users, sessions or the vendor's identity row.
//
//   node scripts/create-tenant.mjs demo "Demo Shop" you@example.com   (once; open the invite link it prints)
//   node scripts/seed-demo.mjs              fill demo (refuses if demo already has items)
//   node scripts/seed-demo.mjs --replace    wipe demo's items, shows, sales and settings first, then fill it
import { d1Target, die, stmt } from "./lib/d1-target.mjs";
import { vendorBinding } from "./lib/wrangler-config.mjs";

const USAGE = "Usage: node scripts/seed-demo.mjs [--replace]   (local only; fills the vendor \"demo\")";
const SLUG = "demo";

// ---------- arguments: checked before any database is opened ----------
const args = process.argv.slice(2);
for (const a of args) {
  if (a === "--remote" || a.startsWith("--remote=")) die("Refusing: seed-demo is LOCAL ONLY. It never runs with --remote.");
  if (/venstock-dev|show-pos|remote/i.test(a)) die(`Refusing: "${a}" looks like a remote database. seed-demo is LOCAL ONLY.`);
  if (a !== "--replace" && a !== "--local") die(`Unknown argument ${a}.\n${USAGE}`);
}
const replace = args.includes("--replace");

const t = d1Target({ remote: false });
if (t.remote) die("Refusing: not a local target."); // belt and braces: d1Target was told local
if (!t.tableExists("CONTROL", "tenants")) die("The control database isn't set up: run node scripts/migrate.mjs --control first.");
const all = t.query("CONTROL", stmt("SELECT id, slug, name, status, db_name, db_id FROM tenants WHERE status != 'deleted' ORDER BY id"));
const tenant = all.find((v) => v.slug === SLUG);
if (!tenant) die(`No local vendor "${SLUG}". Create it first:\n  node scripts/create-tenant.mjs ${SLUG} "Demo Shop" you@example.com`);
if (!tenant.db_id) die(`"${SLUG}" has no database yet; finish it with node scripts/create-tenant.mjs --resume ${SLUG}.`);
if (!/^venstock-local-t\d+$/.test(tenant.db_name)) die(`Refusing: ${SLUG}'s database is ${tenant.db_name}, not a local venstock-local-t<id>.`);
t.writeConfig(all);
const binding = vendorBinding(tenant.id);

const [identity] = t.query(binding, stmt("SELECT tenant_id, slug FROM vendor_identity"));
if (!identity || identity.tenant_id !== tenant.id || identity.slug !== SLUG) {
  die(`STOP: ${binding} (${tenant.db_name}) doesn't identify as ${SLUG}: ${JSON.stringify(identity ?? null)}. Nothing was changed.`);
}
const [{ n: itemCount }] = t.query(binding, stmt("SELECT count(*) AS n FROM items"));
if (itemCount && !replace) die(`"${SLUG}" already has ${itemCount} items. Run with --replace to wipe its items, shows, sales and settings and seed again.`);

// ---------- the data ----------
// A small deterministic random source, so every seed looks the same.
let seed = 20261122;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[Math.floor(rand() * list.length)];

// [name, category, sku, price in dollars, stock at the start of the day, active]
const ITEMS = [
  ["Harbor at Dusk, 8x10 print", "Prints", "PR-001", 25, 18, 1],
  ["Harbor at Dusk, 11x14 print", "Prints", "PR-002", 40, 9, 1],
  ["Night Ferry, 8x10 print", "Prints", "PR-003", 25, 14, 1],
  ["Salt Marsh, 5x7 print", "Prints", "PR-004", 15, 22, 1],
  ["Lighthouse Study, 5x7 print", "Prints", "PR-005", 15, 3, 1],
  ["Tide Chart, 11x14 print", "Prints", "PR-006", 40, 0, 1],
  ["Gull sticker", "Stickers", "ST-001", 4, 60, 1],
  ["Buoy sticker", "Stickers", "ST-002", 4, 48, 1],
  ["Crab sticker", "Stickers", "ST-003", 4, 35, 1],
  ["Rope knot sticker", "Stickers", "ST-004", 4, 6, 1],
  ["Sticker sheet (6)", "Stickers", "ST-005", 12, 20, 1],
  ["Anchor enamel pin", "Pins", "PN-001", 12, 24, 1],
  ["Oyster enamel pin", "Pins", "PN-002", 12, 15, 1],
  ["Kayak enamel pin", "Pins", "PN-003", 12, 0, 1],
  ["Signal flag pin set", "Pins", "PN-004", 30, 7, 1],
  ["Harbor tee, S", "Apparel", "TS-S", 32, 6, 1],
  ["Harbor tee, M", "Apparel", "TS-M", 32, 10, 1],
  ["Harbor tee, L", "Apparel", "TS-L", 32, 8, 1],
  ["Harbor tee, XL", "Apparel", "TS-XL", 32, 2, 1],
  ["Canvas tote", "Apparel", "TO-001", 22, 16, 1],
  ["Pocket notebook", "Paper", "NB-001", 9, 30, 1],
  ["Greeting card, blank", "Paper", "GC-001", 6, 40, 1],
  ["Postcard set (5)", "Paper", "PC-001", 10, 25, 1],
  ["Winter calendar (retired)", "Paper", "CA-001", 18, 4, 0],
];

const now = new Date();
const iso = (d) => d.toISOString();
const hoursAgo = (h) => new Date(now.getTime() - h * 3600_000);
const day = (offset) => { const d = new Date(now); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };

const SHOWS = [
  { name: "Riverside Holiday Market", started_at: iso(new Date(now.getTime() - 15 * 86400_000)), ended_at: iso(new Date(now.getTime() - 15 * 86400_000 + 7 * 3600_000)) },
  { name: "Old Mill Craft Fair", started_at: iso(new Date(now.getTime() - 8 * 86400_000)), ended_at: iso(new Date(now.getTime() - 8 * 86400_000 + 6 * 3600_000)) },
  { name: "Harbor Street Makers Market", started_at: iso(hoursAgo(6)), ended_at: null }, // running now
];
const UPCOMING = [
  ["Winter Night Market", day(6), "16:00", "21:00"],
  ["Library Book & Art Fair", day(13), "10:00", "15:00"],
  ["New Year Flea", day(40), "", ""],
];
const DEALS = [{ qty: 3, unit_price_cents: 400, off_cents: 200 }]; // any 3 stickers for $10
const NOTES = ["Gift wrap", "Paid with exact change", "Repeat customer", "Asked about custom prints", "Holding until 3pm"];

// ~40 sales over the running show's six hours, on two registers. Stock is tracked so nothing sells below zero.
const stock = ITEMS.map((i) => i[4]);
const sales = [];
for (let n = 0; n < 40; n++) {
  const at = new Date(now.getTime() - 6 * 3600_000 + Math.floor(((n + rand()) / 40) * 6 * 3600_000 - 60_000));
  const lines = [];
  const count = 1 + Math.floor(rand() * 3);
  for (let k = 0; k < count; k++) {
    const idx = Math.floor(rand() * ITEMS.length);
    const [name, , , price, , active] = ITEMS[idx];
    if (!active || stock[idx] < 1 || lines.some((l) => l.idx === idx)) continue;
    const qty = ITEMS[idx][1] === "Stickers" ? 1 + Math.floor(rand() * 3) : 1;
    const q = Math.min(qty, stock[idx]);
    stock[idx] -= q;
    lines.push({ idx, name, qty: q, price_cents: price * 100 });
  }
  if (!lines.length) continue;
  const subtotal = lines.reduce((s, l) => s + l.qty * l.price_cents, 0);
  const stickers = lines.filter((l) => ITEMS[l.idx][1] === "Stickers" && l.price_cents === 400).reduce((s, l) => s + l.qty, 0);
  let discount = Math.floor(stickers / 3) * 200, label = discount ? "Bundle deal" : "";
  if (n % 11 === 5) { discount += Math.round(subtotal * 0.1); label = discount > Math.round(subtotal * 0.1) ? "Bundle deal + 10% off" : "10% off"; }
  discount = Math.min(discount, subtotal);
  sales.push({
    client_id: `seed-demo-${n}`, created_at: iso(at), payment_method: pick(["cash", "cash", "venmo", "venmo", "zelle"]),
    register: n % 3 === 0 ? "Register 2" : "Register 1", notes: n % 9 === 4 ? pick(NOTES) : "",
    subtotal, discount, label, total: subtotal - discount, voided: n === 17 ? 1 : 0, lines,
  });
}
// A voided sale gives its stock back (that is what the app does).
for (const s of sales) if (s.voided) for (const l of s.lines) stock[l.idx] += l.qty;

// ---------- write it, all or nothing ----------
const stmts = [];
if (replace) {
  for (const table of ["sale_items", "sales", "items", "shows", "upcoming_shows", "settings"]) stmts.push(stmt(`DELETE FROM ${table}`));
}
ITEMS.forEach(([name, category, sku, price, , active], i) => {
  stmts.push(stmt("INSERT INTO items (name, category, sku, price_cents, stock, active) VALUES (?,?,?,?,?,?)", name, category, sku, price * 100, stock[i], active));
});
for (const s of SHOWS) stmts.push(stmt("INSERT INTO shows (name, started_at, ended_at) VALUES (?,?,?)", s.name, s.started_at, s.ended_at));
for (const [name, date, start, end] of UPCOMING) {
  stmts.push(stmt("INSERT INTO upcoming_shows (name, show_date, start_time, end_time) VALUES (?,?,?,?)", name, date, start, end));
}
stmts.push(stmt("INSERT OR REPLACE INTO settings (key, value) VALUES ('registers', ?)", JSON.stringify(2)));
stmts.push(stmt("INSERT OR REPLACE INTO settings (key, value) VALUES ('deals', ?)", JSON.stringify(DEALS)));
const RUNNING = "(SELECT id FROM shows WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1)";
for (const s of sales) {
  stmts.push(stmt(`INSERT INTO sales (client_id, show_id, payment_method, total_cents, created_at, voided, register, notes,
      subtotal_cents, discount_cents, discount_label) VALUES (?, ${RUNNING}, ?,?,?,?,?,?,?,?,?)`,
    s.client_id, s.payment_method, s.total, s.created_at, s.voided, s.register, s.notes, s.subtotal, s.discount, s.label));
  for (const l of s.lines) {
    stmts.push(stmt(`INSERT INTO sale_items (sale_id, item_id, name, qty, price_cents)
      VALUES ((SELECT id FROM sales WHERE client_id = ?), (SELECT id FROM items WHERE sku = ?), ?, ?, ?)`,
      s.client_id, ITEMS[l.idx][2], l.name, l.qty, l.price_cents));
  }
}
t.run(binding, ...stmts);

const kept = sales.filter((s) => !s.voided);
const money = (c) => `$${(c / 100).toFixed(2)}`;
console.log(`\nSeeded "${tenant.name}" (${SLUG}, ${tenant.db_name}): ${ITEMS.length} items, ${SHOWS.length} shows (one running), ` +
  `${UPCOMING.length} upcoming, ${sales.length} sales (${sales.length - kept.length} voided), ${money(kept.reduce((s, x) => s + x.total, 0))} taken today.`);
console.log(`
Preview it locally:
  npx wrangler dev -c .wrangler-generated/local/wrangler.toml --persist-to .wrangler/state
  then open http://${SLUG}.localhost:8788 and log in as ${SLUG}'s admin.
  No login yet? node scripts/add-admin.mjs --tenant ${SLUG} you@example.com prints an invite link.
`);
