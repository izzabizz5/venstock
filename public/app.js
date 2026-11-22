// Venstock — plain JavaScript, no build step. Everything is in this one file.
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (c) => (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toFixed(2);
const toCents = (v) => Math.round(parseFloat(String(v ?? "").replace(/[$,\s]/g, "")) * 100) || 0;
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  tab: "sell",
  items: store.get("items", []),
  settings: store.get("settings", { registers: 3, deals: [] }),
  show: store.get("show", null),
  sales: store.get("sales", []),      // synced sales for current show
  summary: store.get("summary", null),
  shows: store.get("shows", []),
  upcoming: store.get("upcoming", []), // shows entered ahead of time, not started yet
  editUpcoming: null,                  // id of the upcoming show being edited
  pending: store.get("pending", []),  // sales saved on this device, not yet uploaded
  failed: store.get("failed", []),    // sales the server refused (400/422): { sale, status, error, at }, kept until removed
  register: store.get("register", "Register 1"), // each device/person picks its own register
  // the transaction in progress on this device (kept if the page reloads)
  cart: store.get("cart", {}),        // item_id -> qty
  discount: store.get("discount", { type: "none", value: "" }),
  notes: store.get("notes", ""),
  payment: store.get("payment", "cash"),
  cashGiven: "",
  // sell screen filters
  category: "All",
  search: "",
  // other screens
  modal: null,          // "checkout" | "restock"
  restock: {},          // item_id -> qty to add
  restockSearch: "",
  salesRegister: "All",
  itemSearch: "",
  importPreview: null,  // { rows, fileName, warnings }
  online: true,
  // login
  me: store.get("me", null), // { email, is_admin, stage } — stage "ok" means fully logged in (password + code)
  auth: null,                // what the login screen is showing; see authState()
  users: null,               // admins: who can log in
  usersError: "",
  lastInvite: null,          // { email, invite } just created, shown so it can be sent
};
const saveTxn = () => {
  store.set("cart", state.cart); store.set("discount", state.discount);
  store.set("notes", state.notes); store.set("payment", state.payment);
};

async function api(path, opts = {}) {
  const r = await fetch("/api/" + path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    const err = new Error((await r.json().catch(() => ({}))).error || "Error " + r.status);
    err.status = r.status;
    // session ended (expired, or reset by an admin): back to the login screen
    if (r.status === 401 && !path.startsWith("auth/")) loggedOut("You've been logged out. Log in again — any sales saved on this device will upload after.");
    throw err;
  }
  return r.json();
}
// fetch() throws a TypeError when there's no connection
const errText = (e) => (e.status || !(e instanceof TypeError) ? e.message : "You're offline — try again when you have signal.");

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 3500);
}

// ---------- data sync ----------
let syncing = false;
async function sync() {
  if (syncing || !loggedIn() || inSupport()) return; // a support session never uploads (or keeps) sales
  syncing = true;
  try {
    // Rules in sync.js: 2xx uploaded; 400/422 refused for good (moved to "failed" for a person to look at); anything
    // else (offline, logged out, 403, 404, 409, 429, 5xx) stays queued and ends this pass.
    const post = (sale) => api("sales", { method: "POST", body: sale })
      .then(() => ({ status: 200 }), (e) => ({ status: e.status || 0, error: e.message }));
    const batch = [...state.pending];
    const r = await VenstockSync.uploadPending(batch, post);
    const finished = new Set(batch.filter((s) => !r.pending.includes(s)));
    state.pending = state.pending.filter((s) => !finished.has(s)); // sales rung up during the pass stay queued
    store.set("pending", state.pending);
    if (r.failed.length) {
      state.failed = [...state.failed, ...r.failed];
      store.set("failed", state.failed);
      toast(`${r.failed.length} sale${r.failed.length === 1 ? "" : "s"} couldn't be uploaded. See the Sales tab.`);
    }
    if (r.stopped === 0 || r.stopped === 401) throw new Error("offline or logged out: try again later");
    await refresh();
    state.online = true;
  } catch (e) {
    state.online = false;
  }
  syncing = false;
  paintHeader();
  softRender();
}

async function refresh() {
  const support = inSupport(); // decided once: the session may end while this runs
  const [items, settings, show, shows, upcoming] = await Promise.all([
    api("items?all=1"), api("settings"), api("shows/active"), api("shows"),
    api("shows/upcoming").catch(() => state.upcoming), // keep working if the database isn't updated yet
  ]);
  Object.assign(state, { items, settings, show, shows, upcoming });
  if (state.show) {
    [state.sales, state.summary] = await Promise.all([
      api(`shows/${state.show.id}/sales`), api(`shows/${state.show.id}/summary`),
    ]);
  } else {
    state.sales = await api("sales/unassigned"); state.summary = null;
  }
  // stock shown here = server stock minus this device's sales that haven't uploaded yet
  for (const sale of state.pending) for (const l of sale.items) {
    const it = state.items.find((i) => i.id === l.item_id);
    if (it) it.stock -= l.qty;
  }
  // A support session never keeps the shop's data on the device (it's a Venstock staff browser).
  if (!support && state.me) for (const k of SHOP_KEYS) store.set(k, state[k]);
}

// The shop's data as saved on this device (sales not uploaded yet, "pending" and "failed", are not in this list).
const SHOP_KEYS = ["items", "settings", "show", "sales", "summary", "shows", "upcoming"];
function forgetShop() {
  for (const k of SHOP_KEYS) store.set(k, null);
  Object.assign(state, { items: [], show: null, sales: [], summary: null, shows: [], upcoming: [], users: null, lastInvite: null, supportVisits: null });
}

// A Venstock support session (read-only, opened from the platform admin's one-time link): /api/auth/me says so.
// It ends by the banner's button, by running out (the API answers 401) or by a platform admin; every way out goes
// through endedSupport(), so none of the shop's data is left in the staff member's browser.
const inSupport = () => !!(state.me && state.me.support);
function endedSupport(info = "The support session has ended.") {
  forgetShop(); resetTxn();
  state.me = null; store.set("me", null);
  state.auth = authState("login", info);
  state.tab = "sell";
  if (state.modal) closeModal(false);
  render(); paintSupportBanner();
}
function paintSupportBanner() {
  let b = document.getElementById("supportBanner");
  if (!inSupport()) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement("div");
    b.id = "supportBanner";
    b.className = "support-banner";
    b.setAttribute("role", "status");
    document.body.prepend(b);
  }
  const until = new Date(state.me.support.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  b.innerHTML = `Venstock support session: read-only, ends at ${esc(until)}. <button class="sm" data-endsupport>End now</button>`;
}

function paintHeader() {
  paintSupportBanner();
  $("#showName").textContent = state.show ? state.show.name : "No show running";
  const n = state.pending.length, f = state.failed.length;
  const s = $("#sync");
  s.textContent = [f ? `${f} failed` : "", n ? `${n} to upload` : "", !f && !n ? (state.online ? "✓ synced" : "offline") : ""].filter(Boolean).join(" · ");
  s.className = n || f || !state.online ? "warn" : "";
  if (f) s.dataset.tab = "sales"; else delete s.dataset.tab; // tap to see the failed sales
}

// ---------- discounts & bundle deals ----------
// Deals always apply on their own as soon as the order qualifies. Each deal matches items by price:
// "buy 2 items priced $7, get $2 off". Deals repeat (4 × $7 items = $4 off) and the
// customer always gets the biggest saving possible.
const deals = () => (state.settings.deals || []).filter((d) => d.qty >= 2 && d.unit_price_cents > 0 && d.off_cents > 0);
const short = (c) => money(c).replace(".00", "");
const dealText = (d) => `Buy ${d.qty} ${short(d.unit_price_cents)} items, get ${short(d.off_cents)} off`;

// Most you can save on `count` items of one price with that price's deals,
// plus which deals that uses and how many times.
function bestPlan(count, list) {
  const dp = [0], pick = [null];
  for (let i = 1; i <= count; i++) {
    dp[i] = dp[i - 1]; pick[i] = null;
    for (const d of list) if (i >= d.qty && dp[i - d.qty] + d.off_cents > dp[i]) { dp[i] = dp[i - d.qty] + d.off_cents; pick[i] = d; }
  }
  const used = new Map();
  for (let i = count; i > 0;) {
    const d = pick[i];
    if (d) { used.set(d, (used.get(d) || 0) + 1); i -= d.qty; } else i--;
  }
  return { saved: dp[count], used };
}
const bestSavings = (count, list) => bestPlan(count, list).saved;

// Returns the bundle saving for the order, plus a hint when one more item would unlock a deal.
function bundleDeals(lines) {
  const counts = {};
  for (const l of lines) counts[l.item.price_cents] = (counts[l.item.price_cents] || 0) + l.qty;
  let saved = 0, hint = "";
  const applied = []; // [{ deal, times }] — only deals this order actually qualifies for
  for (const [price, n] of Object.entries(counts)) {
    const list = deals().filter((d) => d.unit_price_cents === Number(price));
    if (!list.length) continue;
    const plan = bestPlan(n, list);
    const s = plan.saved;
    saved += s;
    for (const [deal, times] of plan.used) applied.push({ deal, times });
    // only nudge when a single extra item would unlock a deal
    const gain = bestSavings(n + 1, list) - s;
    if (!hint && gain > 0) hint = `Add 1 more ${short(Number(price))} item to save ${short(gain)}`;
  }
  return { saved, hint, applied };
}

// Optional extra discount on top of the deals, picked when cashing out.
function discountOptions() {
  return [["none", "No extra discount"], ["pct10", "10% off"], ["pct20", "20% off"],
    ["custom_pct", "Custom % off…"], ["custom_amt", "Custom $ off…"]];
}

function currentDiscountType() {
  const t = state.discount.type;
  return discountOptions().some(([v]) => v === t) ? t : "none";
}

function computeTotals() {
  const lines = cartLines();
  const subtotal = lines.reduce((t, l) => t + l.qty * l.item.price_cents, 0);
  const bundle = bundleDeals(lines);
  const afterDeals = subtotal - bundle.saved;
  const type = currentDiscountType();
  const v = parseFloat(state.discount.value) || 0;
  let extra = 0, extraLabel = "";
  if (type === "pct10") { extra = Math.round(afterDeals * 0.1); extraLabel = "10% off"; }
  else if (type === "pct20") { extra = Math.round(afterDeals * 0.2); extraLabel = "20% off"; }
  else if (type === "custom_pct") { extra = Math.round(afterDeals * Math.min(100, Math.max(0, v)) / 100); extraLabel = `${v}% off`; }
  else if (type === "custom_amt") { extra = Math.max(0, Math.round(v * 100)); extraLabel = `${short(Math.round(v * 100))} off`; }
  extra = Math.min(afterDeals, Math.max(0, extra));
  const discount = bundle.saved + extra;
  const label = [bundle.saved ? "Bundle deal" : "", extra ? extraLabel : ""].filter(Boolean).join(" + ");
  return { lines, subtotal, deals: bundle.saved, applied: bundle.applied, hint: bundle.hint, extra, discount, label, total: subtotal - discount,
    count: lines.reduce((t, l) => t + l.qty, 0) };
}

// ---------- SELL ----------
function cartLines() {
  return Object.entries(state.cart)
    .map(([id, qty]) => ({ item: state.items.find((i) => i.id == id), qty }))
    .filter((l) => l.item && l.qty > 0);
}

function categories() {
  const seen = [];
  for (const i of state.items) if (i.active && i.category && !seen.includes(i.category)) seen.push(i.category);
  return seen;
}

function registerNames() {
  const n = Math.max(1, state.settings.registers || 1);
  const names = Array.from({ length: n }, (_, i) => `Register ${i + 1}`);
  if (!names.includes(state.register)) names.push(state.register);
  return names;
}

function visibleItems() {
  const q = state.search.trim().toLowerCase();
  return state.items.filter((i) => i.active
    && (state.category === "All" || i.category === state.category)
    && (!q || i.name.toLowerCase().includes(q) || (i.sku || "").toLowerCase().includes(q)
      || (i.category || "").toLowerCase().includes(q)));
}

function gridHTML() {
  const list = visibleItems();
  if (!list.length) {
    return `<p class="muted empty">${state.items.some((i) => i.active)
      ? "No items match." : "No items yet — add them in the Items tab, or import your spreadsheet as a CSV."}</p>`;
  }
  return list.map((i) => {
    const inCart = state.cart[i.id] || 0;
    // most items are one-of-a-kind, so only flag "out"; dims once the last one is in the cart
    const cls = i.stock - inCart <= 0 ? "out" : "";
    return `
    <button class="product ${cls} ${inCart ? "in-cart" : ""}" data-add="${i.id}">
      ${inCart ? `<span class="badge">${inCart}</span>` : ""}
      <span class="cat">${esc(i.category || "Item")}</span>
      <span class="pname">${esc(i.name)}</span>
      <span class="price">${money(i.price_cents)}</span>
      <span class="stock">In Stock: ${i.stock}</span>
    </button>`;
  }).join("");
}

function chipsHTML() {
  return ["All", ...categories()].map((c) =>
    `<button class="chip ${state.category === c ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
}

function linesHTML() {
  const lines = cartLines();
  if (!lines.length) return `<p class="muted empty-cart">Tap items to add them to the order.</p>`;
  return lines.map((l) => `
    <div class="line">
      <div class="line-name">${esc(l.item.name)}<small>${money(l.item.price_cents)} each</small></div>
      <div class="qty">
        <button class="qbtn" data-dec="${l.item.id}" aria-label="One less">−</button>
        <b>${l.qty}</b>
        <button class="qbtn" data-add="${l.item.id}" aria-label="One more">+</button>
      </div>
      <div class="line-total">${money(l.qty * l.item.price_cents)}</div>
      <button class="x" data-remove="${l.item.id}" aria-label="Remove">×</button>
    </div>`).join("");
}

function discountSelectHTML(id) {
  const type = currentDiscountType();
  const custom = type === "custom_pct" || type === "custom_amt";
  return `
    <select id="${id}" data-discount>
      ${discountOptions().map(([v, l]) => `<option value="${v}" ${v === type ? "selected" : ""}>${esc(l)}</option>`).join("")}
    </select>
    ${custom ? `<input class="disc-val" data-discval type="number" inputmode="decimal" min="0" step="0.01"
      placeholder="${type === "custom_pct" ? "Percent off, e.g. 15" : "Dollars off, e.g. 5"}" value="${esc(state.discount.value)}">` : ""}`;
}

function totalsHTML() {
  const t = computeTotals();
  return `
    <div class="trow"><span>Subtotal:</span><span>${money(t.subtotal)}</span></div>
    ${t.deals ? `<div class="trow deal"><span>Bundle Deals:</span><span>-${money(t.deals)}</span></div>` : ""}
    ${t.extra ? `<div class="trow deal"><span>Extra discount:</span><span>-${money(t.extra)}</span></div>` : ""}
    <div class="trow grand"><span>Total:</span><span>${money(t.total)}</span></div>
    ${t.hint ? `<div class="hint">${esc(t.hint)}</div>` : ""}`;
}

// Deals the current order qualifies for (nothing shows until the order matches one).
function dealsListHTML(t = computeTotals()) {
  if (!t.applied.length) return "";
  return `<ul class="deal-list">${t.applied.map(({ deal, times }) =>
    `<li><span>${esc(dealText(deal))}${times > 1 ? ` ×${times}` : ""}</span><b>-${money(deal.off_cents * times)}</b></li>`).join("")}</ul>`;
}

function viewSell() {
  const t = computeTotals();
  return `
  <div class="pos">
    <section class="catalog">
      <div class="notice" id="noShow" ${state.show ? "hidden" : ""}>${noShowHTML()}</div>
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search item or SKU..." value="${esc(state.search)}" autocomplete="off">
        <button class="restock-btn" data-open="restock">+ Restock</button>
      </div>
      <div class="chips" id="chips">${chipsHTML()}</div>
      <div class="products" id="grid">${gridHTML()}</div>
    </section>

    <aside class="order" id="order">
      <div class="order-head">
        <h2>Current Order</h2>
        <select id="register" aria-label="Register">
          ${registerNames().map((r) => `<option ${r === state.register ? "selected" : ""}>${esc(r)}</option>`).join("")}
        </select>
        <button class="sheet-close" data-sheet="close" aria-label="Back to items">×</button>
      </div>
      <div class="lines" id="lines">${linesHTML()}</div>

      <div class="deals-box">
        <div class="label">Discounts &amp; Deals</div>
        <div id="dealList">${dealsListHTML()}</div>
        <div id="discountPanel">${discountSelectHTML("discountSel")}</div>
      </div>
      <div class="totals" id="totals">${totalsHTML()}</div>

      <select id="payment" aria-label="Payment method">
        <option value="cash" ${state.payment === "cash" ? "selected" : ""}>Cash</option>
        <option value="venmo" ${state.payment === "venmo" ? "selected" : ""}>Venmo</option>
        <option value="zelle" ${state.payment === "zelle" ? "selected" : ""}>Zelle</option>
      </select>
      <input id="notes" placeholder="Customer name or notes (optional)" value="${esc(state.notes)}">
      <button class="complete" data-open="checkout" id="completeBtn" ${t.lines.length ? "" : "disabled"}>Complete Sale</button>
      <button class="link danger" data-clear>Clear Cart</button>
    </aside>
  </div>
  <button class="sheet-backdrop" data-sheet="close" aria-label="Back to items" tabindex="-1"></button>
  <button class="cart-bar ${t.count ? "" : "empty"}" id="cartBar" data-sheet="open">${cartBarHTML(t)}</button>`;
}

// Phones only: the bar at the bottom that opens the order panel.
function cartBarHTML(t) {
  return t.count
    ? `<span>${t.count} item${t.count === 1 ? "" : "s"}</span><b>${money(t.total)}</b><span>View order ↑</span>`
    : `<span>No items yet</span><span>${esc(state.register)} ↑</span>`;
}
const closeSheet = () => document.body.classList.remove("sheet-open");

// Repaint just the parts of the sell screen that change, so typing in search/notes isn't interrupted.
function paintSell() {
  if (state.tab !== "sell" || !$("#grid")) return;
  const t = computeTotals();
  $("#grid").innerHTML = gridHTML();
  $("#chips").innerHTML = chipsHTML();
  $("#lines").innerHTML = linesHTML();
  $("#totals").innerHTML = totalsHTML();
  $("#completeBtn").disabled = !t.lines.length;
  $("#noShow").hidden = !!state.show;
  $("#noShow").innerHTML = noShowHTML();
  // deals / register count may have changed on another device
  const dp = $("#discountPanel");
  if (!dp.contains(document.activeElement)) dp.innerHTML = discountSelectHTML("discountSel");
  $("#dealList").innerHTML = dealsListHTML();
  const reg = $("#register");
  if (document.activeElement !== reg) {
    reg.innerHTML = registerNames().map((r) => `<option ${r === state.register ? "selected" : ""}>${esc(r)}</option>`).join("");
  }
  const bar = $("#cartBar");
  bar.classList.toggle("empty", !t.count);
  bar.innerHTML = cartBarHTML(t);
  if (state.modal === "checkout") paintCheckout();
}

function addToCart(id) {
  const it = state.items.find((i) => i.id == id);
  if (!it) return;
  const next = (state.cart[id] || 0) + 1;
  if (next > it.stock && !confirm(`Only ${Math.max(0, it.stock)} of "${it.name}" left in stock. Add anyway?`)) return;
  state.cart[id] = next;
  saveTxn(); paintSell();
}

function resetTxn() {
  state.cart = {};
  state.discount = { type: "none", value: "" }; // bundle deals apply on their own
  state.notes = "";
  state.cashGiven = "";
  closeSheet();
  saveTxn();
}

// ---------- CHECKOUT (pops up when cashing someone out) ----------
function checkoutHTML() {
  const t = computeTotals();
  return `
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="coTitle">
    <div class="modal-head">
      <h2 id="coTitle">Checkout</h2>
      <span class="muted">${esc(state.register)} · ${t.count} item${t.count === 1 ? "" : "s"}</span>
    </div>
    <div class="co-items">${t.lines.map((l) => `<div class="trow"><span>${l.qty}× ${esc(l.item.name)}</span><span>${money(l.qty * l.item.price_cents)}</span></div>`).join("")}</div>

    <div class="deals-box">
      <div class="label">Deals &amp; Discount</div>
      <div id="coDealList">${dealsListHTML(t)}</div>
      <div id="coDiscount">${discountSelectHTML("coDiscountSel")}</div>
    </div>
    <div class="totals" id="coTotals">${totalsHTML()}</div>

    <div class="label">Payment</div>
    <div class="paytoggle">
      <button class="${state.payment === "cash" ? "on" : ""}" data-paymethod="cash">Cash</button>
      <button class="${state.payment === "venmo" ? "on" : ""}" data-paymethod="venmo">Venmo</button>
      <button class="${state.payment === "zelle" ? "on" : ""}" data-paymethod="zelle">Zelle</button>
    </div>
    <div id="cashBox">${cashBoxHTML()}</div>

    <div class="label">Customer notes</div>
    <textarea id="coNotes" rows="2" placeholder="Customer name, custom order details, follow-up…">${esc(state.notes)}</textarea>

    <button class="complete" data-confirm id="coConfirm">Confirm Sale · ${money(t.total)}</button>
    <div class="modal-actions">
      <button class="link" data-close>← Back to order</button>
      <button class="link danger" data-canceltxn>Cancel Transaction</button>
    </div>
  </div>`;
}

const PAY_LABELS = { cash: "Cash", venmo: "Venmo", zelle: "Zelle" };
const payLabel = (m) => PAY_LABELS[m] || m;

function cashBoxHTML() {
  if (state.payment !== "cash") return `<p class="muted">Have them send ${money(computeTotals().total)} on ${payLabel(state.payment)}, then confirm.</p>`;
  const total = computeTotals().total;
  const quick = [...new Set([total, ...[500, 1000, 2000, 5000, 10000].filter((b) => b > total).slice(0, 3)])];
  return `
    <div class="cash">
      <label>Cash received <input id="cashGiven" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(state.cashGiven)}" placeholder="0.00"></label>
      <div class="quick">${quick.map((c, i) => `<button class="chip" data-given="${c}">${i === 0 ? "Exact" : money(c).replace(".00", "")}</button>`).join("")}</div>
      <div id="change" class="change">${changeText()}</div>
    </div>`;
}

function changeText() {
  if (state.cashGiven === "") return "";
  const due = toCents(state.cashGiven) - computeTotals().total;
  return due < 0 ? `<span class="danger">Still owed ${money(-due)}</span>` : `Change due: <b>${money(due)}</b>`;
}

function paintCheckout() {
  const t = computeTotals();
  if (!t.lines.length) { closeModal(); return; }
  $("#coTotals").innerHTML = totalsHTML();
  $("#coDealList").innerHTML = dealsListHTML(t);
  $("#coConfirm").textContent = `Confirm Sale · ${money(t.total)}`;
  const ch = $("#change");
  if (ch) ch.innerHTML = changeText();
}

function completeSale() {
  if (inSupport()) { toast("This is a read-only support session: nothing can be sold or changed."); return; }
  const t = computeTotals();
  if (!t.lines.length) return;
  if (state.payment === "cash" && state.cashGiven !== "" && toCents(state.cashGiven) < t.total
    && !confirm("Cash received is less than the total. Complete the sale anyway?")) return;
  const sale = {
    client_id: crypto.randomUUID(),
    show_id: state.show ? state.show.id : null,
    payment_method: state.payment,
    register: state.register,
    notes: state.notes.trim(),
    discount_cents: t.discount,
    discount_label: t.label,
    created_at: new Date().toISOString(),
    items: t.lines.map((l) => ({ item_id: l.item.id, name: l.item.name, qty: l.qty, price_cents: l.item.price_cents })),
  };
  const change = state.payment === "cash" && state.cashGiven !== "" ? toCents(state.cashGiven) - t.total : null;
  t.lines.forEach((l) => { l.item.stock -= l.qty; }); // update counts on screen right away
  state.pending.push(sale);
  store.set("pending", state.pending); store.set("items", state.items);
  resetTxn();
  closeModal(false);
  toast(`Sale saved · ${money(t.total)}${change > 0 ? ` · Change due ${money(change)}` : ""}`);
  paintHeader(); render(); sync();
}

// ---------- RESTOCK (quick add stock from the sell screen) ----------
function restockHTML() {
  return `
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="rsTitle">
    <div class="modal-head"><h2 id="rsTitle">Restock</h2><span class="muted">Enter how many you're adding</span></div>
    <input id="rsSearch" type="search" placeholder="Search item or SKU..." value="${esc(state.restockSearch)}">
    <div class="rs-list" id="rsList">${restockListHTML()}</div>
    <button class="complete" data-saverestock>Add to stock</button>
    <div class="modal-actions">
      <button class="link" data-close>Cancel</button>
      <span class="muted">New item? Add it in the Items tab.</span>
    </div>
  </div>`;
}

function restockListHTML() {
  const q = state.restockSearch.trim().toLowerCase();
  const list = state.items.filter((i) => !q || i.name.toLowerCase().includes(q) || (i.sku || "").toLowerCase().includes(q)
    || (i.category || "").toLowerCase().includes(q));
  return list.map((i) => `
    <label class="rs-row ${i.active ? "" : "hidden-item"}">
      <span class="grow">${esc(i.name)}<small>${esc(i.category || "")}${i.active ? "" : " · hidden"} · in stock: ${i.stock}</small></span>
      <input type="number" inputmode="numeric" class="num" data-rs="${i.id}" placeholder="+0" value="${state.restock[i.id] || ""}">
    </label>`).join("") || `<p class="muted">No items match.</p>`;
}

// ---------- modal plumbing ----------
function openModal(name) {
  state.modal = name;
  const m = $("#modal");
  m.innerHTML = name === "checkout" ? checkoutHTML() : restockHTML();
  m.hidden = false;
  document.body.classList.add("modal-open");
  // on phones, don't pop the keyboard open over the popup
  if (matchMedia("(min-width: 761px)").matches) (name === "checkout" ? $("#cashGiven") || $("#coConfirm") : $("#rsSearch"))?.focus();
}
function closeModal(repaint = true) {
  state.modal = null;
  const m = $("#modal");
  m.hidden = true; m.innerHTML = "";
  document.body.classList.remove("modal-open");
  if (repaint) render();
}

// ---------- SALES ----------
// Sales the server refused. They never upload by themselves: someone retries (after fixing the cause, e.g. re-adding a
// deleted item), keeps a record (CSV) and removes them.
function failedHTML() {
  if (!state.failed.length) return "";
  const n = state.failed.length;
  const time = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `
    <div class="card failed"><strong>${n} sale${n === 1 ? "" : "s"} couldn't be uploaded</strong>
      <p class="muted">The server refused ${n === 1 ? "this sale" : "these sales"}, so ${n === 1 ? "it isn't" : "they aren't"} in your totals.
        ${n === 1 ? "It stays" : "They stay"} on this device until you remove ${n === 1 ? "it" : "them"}. Download a copy before removing anything.</p>
      <button class="sm" data-failedcsv>Download as CSV</button></div>
    ${state.failed.map((f, i) => `
      <div class="card failed"><div class="row"><span class="grow">${f.sale.items.map((l) => `${l.qty}× ${esc(l.name)}`).join(", ")}</span>
        <button class="sm" data-failretry="${i}">Try again</button> <button class="sm danger" data-failremove="${i}">Remove</button></div>
        <div class="muted">${esc(time(f.sale.created_at))} · ${esc(payLabel(f.sale.payment_method))}${f.sale.register ? ` · ${esc(f.sale.register)}` : ""}</div>
        <div class="reason">${esc(f.error)}</div></div>`).join("")}`;
}

function viewSales() {
  const regs = ["All", ...new Set([...state.sales.map((s) => s.register).filter(Boolean), ...state.pending.map((s) => s.register).filter(Boolean)])];
  const reg = regs.includes(state.salesRegister) ? state.salesRegister : "All";
  const keep = (s) => reg === "All" || s.register === reg;
  const pend = state.pending.slice().reverse().filter(keep);
  const sales = state.sales.filter(keep);
  const total = sales.filter((s) => !s.voided).reduce((t, s) => t + s.total_cents, 0);
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const meta = (s, total) => [time(s.created_at), s.register, payLabel(s.payment_method), money(total)]
    .filter(Boolean).map(esc).join(" · ");
  return `
  <div class="page">
    ${regs.length > 2 ? `<div class="chips">${regs.map((r) => `<button class="chip ${r === reg ? "on" : ""}" data-salesreg="${esc(r)}">${esc(r)}</button>`).join("")}</div>` : ""}
    ${state.show ? "" : `<div class="notice">No show is running, so these are sales that aren't part of any show.
      Start a show in the Shows tab to group sales.</div>`}
    ${failedHTML()}
    <div class="card"><strong>${reg !== "All" ? esc(reg) : state.show ? "Total this show" : "Total (not in a show)"}: ${money(total)}</strong></div>
    ${pend.map((s) => {
      const sub = s.items.reduce((t, i) => t + i.qty * i.price_cents, 0);
      return `
      <div class="card"><div class="row"><span class="grow">${s.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(", ")}</span>
        <span class="pill">not uploaded</span></div>
        <div class="muted">${meta(s, sub - (s.discount_cents || 0))}${s.discount_cents ? ` · ${esc(s.discount_label)} −${money(s.discount_cents)}` : ""}</div>
        ${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ""}</div>`;
    }).join("")}
    ${sales.map((s) => `
      <div class="card ${s.voided ? "void" : ""}"><div class="row"><span class="grow">${esc(s.summary || "")}</span>
        ${s.voided ? `<span class="pill gray">cancelled</span>` : `<button class="sm danger" data-void="${s.id}">Cancel sale</button>`}</div>
        <div class="muted">${meta(s, s.total_cents)}${s.discount_cents ? ` · ${esc(s.discount_label || "discount")} −${money(s.discount_cents)}` : ""}</div>
        ${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ""}</div>`).join("")
      || (pend.length ? "" : `<p class="muted">No sales yet.</p>`)}
  </div>`;
}

// ---------- ITEMS (admin) ----------
function viewItems() {
  const cats = categories();
  const q = state.itemSearch.trim().toLowerCase();
  const list = state.items.filter((i) => !q || i.name.toLowerCase().includes(q) || (i.sku || "").toLowerCase().includes(q)
    || (i.category || "").toLowerCase().includes(q));
  const p = state.importPreview;
  return `
  <div class="page">
    <datalist id="catList">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>

    <div class="card">
      <strong>Bulk import from a spreadsheet (CSV)</strong>
      <p class="muted">In Google Sheets: File → Download → Comma-separated values (.csv). In Excel: Save As → CSV.
        Columns needed: <b>Name</b> and <b>Price</b>. Optional: <b>Category</b>, <b>Stock</b> (or Qty), <b>SKU</b>.
        Items already in the app (same SKU, or same name + category) get updated instead of duplicated.</p>
      <div class="row wrap">
        <input type="file" id="csvFile" accept=".csv,text/csv">
        <a href="/api/items/export"><button class="sm">Download current items (CSV)</button></a>
        <button class="sm" data-template>Download blank template</button>
      </div>
      ${p ? `
        <div class="preview">
          <p><b>${esc(p.fileName)}</b>: ${p.rows.length} item${p.rows.length === 1 ? "" : "s"} found.</p>
          ${p.warnings.map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join("")}
          <div class="table-wrap"><table>
            <tr><th>Name</th><th>Category</th><th>SKU</th><th>Price</th><th>Stock</th></tr>
            ${p.rows.slice(0, 8).map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.category)}</td><td>${esc(r.sku)}</td>
              <td>${r.price_cents == null ? "—" : money(r.price_cents)}</td><td>${r.stock ?? "—"}</td></tr>`).join("")}
          </table></div>
          ${p.rows.length > 8 ? `<p class="muted">…and ${p.rows.length - 8} more.</p>` : ""}
          <div class="row wrap">
            <label><input type="radio" name="importMode" value="set" checked> Stock = numbers in the file</label>
            <label><input type="radio" name="importMode" value="add"> Add the file's numbers to current stock</label>
          </div>
          <div class="row"><button class="sm go" data-doimport ${p.rows.length ? "" : "disabled"}>Import ${p.rows.length} items</button>
            <button class="sm" data-cancelimport>Cancel</button></div>
        </div>` : ""}
    </div>

    <div class="card"><strong>Add item</strong>
      <div class="row wrap">
        <input id="newName" class="name" placeholder="Name (e.g. Tee - Medium)">
        <input id="newCat" class="mid" list="catList" placeholder="Category">
        <input id="newSku" class="mid" placeholder="SKU (optional)">
        <input id="newPrice" class="num" type="number" inputmode="decimal" step="0.01" placeholder="Price">
        <input id="newStock" class="num" type="number" inputmode="numeric" placeholder="Qty">
        <button class="sm go" data-additem>Add</button>
      </div>
    </div>

    <div class="card"><strong>Bundle deals</strong>
      <p class="muted">Always on: applied automatically whenever an order qualifies. A deal matches items by price,
        and it repeats when the order qualifies more than once.</p>
      <p class="muted"><strong>Example:</strong> Buy 3 items priced $5.00 → $2.00 off.
        Three $5 tees cost $13 instead of $15, and six cost $26 ($4 off).</p>
      <div id="dealRows">${(state.settings.deals || []).map(dealRowHTML).join("")}</div>
      <div class="row"><button class="sm" data-adddeal>+ Add deal</button><span class="grow"></span><button class="sm go" data-savedeals>Save deals</button></div>
    </div>

    <div class="card"><strong>Registers</strong>
      <p class="muted">Each phone/tablet picks its register on the Sell screen, so several people can ring up sales at once. Stock stays shared.</p>
      <div class="row"><label>Number of registers <input id="regCount" class="num" type="number" min="1" max="20" value="${state.settings.registers || 1}"></label>
        <button class="sm go" data-saveregs>Save</button></div>
    </div>

    <h3>All items (${state.items.length})</h3>
    <p class="muted">Edit a row and tap Save. To restock, change the quantity. Uncheck “Show” to hide an item without deleting it.</p>
    <input id="itemSearch" type="search" class="full" placeholder="Filter items..." value="${esc(state.itemSearch)}">
    <div id="itemList">${list.map(itemRowHTML).join("") || `<p class="muted">No items.</p>`}</div>
  </div>`;
}

function itemRowHTML(i) {
  return `
    <div class="card item-row" data-row="${i.id}">
      <div class="row wrap">
        <input class="name" data-f="name" value="${esc(i.name)}" aria-label="Name">
        <input class="mid" data-f="category" list="catList" value="${esc(i.category)}" placeholder="Category" aria-label="Category">
        <input class="mid" data-f="sku" value="${esc(i.sku)}" placeholder="SKU" aria-label="SKU">
      </div>
      <div class="row wrap">
        <label>$ <input class="num" data-f="price" type="number" inputmode="decimal" step="0.01" value="${(i.price_cents / 100).toFixed(2)}"></label>
        <label>Qty <input class="num" data-f="stock" type="number" inputmode="numeric" value="${i.stock}"></label>
        <label><input data-f="active" type="checkbox" ${i.active ? "checked" : ""}> Show</label>
        <span class="grow"></span><button class="sm go" data-save="${i.id}">Save</button>
      </div>
    </div>`;
}

function dealRowHTML(d = {}) {
  const dollars = (c) => (c ? (c / 100).toFixed(2) : "");
  return `
    <div class="row wrap deal-row">
      <label>Buy <input class="num" data-d="qty" type="number" min="2" value="${d.qty || ""}" placeholder="3"></label>
      <label>items priced $ <input class="num" data-d="unit" type="number" step="0.01" min="0" value="${dollars(d.unit_price_cents)}" placeholder="5.00"></label>
      <label>→ $ <input class="num" data-d="off" type="number" step="0.01" min="0" value="${dollars(d.off_cents)}" placeholder="2.00"> off</label>
      <button class="sm danger" data-deldeal>Remove</button>
    </div>`;
}

// ----- CSV import helpers -----
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const HEADER_ALIASES = {
  name: ["name", "item", "itemname", "product", "productname", "title", "itemdescription", "description"],
  category: ["category", "type", "cat", "producttype", "itemtype", "group", "department"],
  price: ["price", "retail", "retailprice", "unitprice", "sellprice", "saleprice", "sellingprice", "priceeach", "msrp"],
  stock: ["stock", "qty", "quantity", "instock", "inventory", "count", "onhand", "qtyonhand", "amount", "units"],
  sku: ["sku", "code", "itemcode", "barcode", "productcode", "itemnumber", "itemno", "skucode"],
};

function rowsFromCSV(text) {
  const table = parseCSV(text);
  const warnings = [];
  if (!table.length) return { rows: [], warnings: ["The file is empty."] };
  // the header is the first row (within the first 5) that has something that looks like a Name column
  const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
  let headerIdx = -1, cols = {};
  for (let r = 0; r < Math.min(5, table.length) && headerIdx < 0; r++) {
    const heads = table[r].map(norm);
    const found = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      const idx = aliases.map((a) => heads.indexOf(a)).find((i) => i >= 0);
      if (idx !== undefined) found[field] = idx;
    }
    if (found.name !== undefined) { headerIdx = r; cols = found; }
  }
  if (headerIdx < 0) return { rows: [], warnings: ['Couldn\'t find a "Name" (or "Item") column header in the first rows of the file.'] };
  if (cols.price === undefined) warnings.push("No Price column found — new items will be $0.00, existing prices kept.");
  if (cols.stock === undefined) warnings.push("No Stock/Qty column found — new items start at 0, existing stock kept.");
  if (cols.category === undefined) warnings.push("No Category column found — items won't be grouped into tabs.");

  const rows = [];
  let badPrice = 0;
  for (const r of table.slice(headerIdx + 1)) {
    const get = (f) => (cols[f] === undefined ? "" : String(r[cols[f]] ?? "").trim());
    const name = get("name");
    if (!name) continue;
    const priceRaw = get("price"), stockRaw = get("stock");
    let price_cents = null;
    if (priceRaw !== "") {
      const v = parseFloat(priceRaw.replace(/[$,\s]/g, ""));
      if (Number.isFinite(v)) price_cents = Math.round(v * 100); else badPrice++;
    }
    const s = parseInt(stockRaw.replace(/[,\s]/g, ""), 10);
    rows.push({ name, category: get("category"), sku: get("sku"), price_cents, stock: Number.isFinite(s) ? s : null });
  }
  if (badPrice) warnings.push(`${badPrice} row(s) have a price that isn't a number — their price will be left as is.`);
  return { rows, warnings };
}

function downloadText(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- SHOWS ----------
const pad2 = (n) => String(n).padStart(2, "0");
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], {
    weekday: "short", month: "short", day: "numeric", year: y !== new Date().getFullYear() ? "numeric" : undefined });
}
function fmtTime(hm) {
  if (!hm) return "";
  const [h, m] = hm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
const timesText = (u) => [fmtTime(u.start_time), fmtTime(u.end_time)].filter(Boolean).join(" – ");
const whenText = (u) => [fmtDate(u.show_date), timesText(u)].filter(Boolean).join(" · ");

// Sell screen banner when no show is running; offers to start today's show if one is scheduled.
function noShowHTML() {
  const t = state.upcoming.find((u) => u.show_date === todayISO());
  if (!t) return "No show is running. Sales still save — start a show in the Shows tab to group them.";
  return `Today's show <b>${esc(t.name)}</b>${t.start_time ? ` (${esc(timesText(t))})` : ""} hasn't been started.
    <button class="sm go" data-startupcoming="${t.id}">Start it</button>`;
}

function upcomingHTML() {
  const today = todayISO();
  const edit = state.upcoming.find((u) => u.id === state.editUpcoming);
  const v = (k) => esc(edit?.[k] || "");
  return `
    <div class="card"><strong>Upcoming shows</strong>
      ${state.upcoming.map((u) => `
        <div class="row wrap up-row ${u.id === state.editUpcoming ? "editing" : ""}">
          <span class="grow">${esc(u.name)}
            ${u.show_date === today ? `<span class="pill">today</span>` : u.show_date < today ? `<span class="pill gray">date passed</span>` : ""}
            <br><span class="muted">${esc(whenText(u))}</span></span>
          <button class="sm go" data-startupcoming="${u.id}">Start</button>
          <button class="sm" data-editupcoming="${u.id}">Edit</button>
          <button class="sm danger" data-delupcoming="${u.id}">Delete</button>
        </div>`).join("") || `<p class="muted">Nothing scheduled. Add your next shows below, then tap Start when you open.</p>`}
      <form data-upcomingform class="up-form" id="upForm">
        <div class="label">${edit ? `Editing “${esc(edit.name)}”` : "Add a show"}</div>
        <div class="row wrap">
          <input name="name" class="name" placeholder="Show name (e.g. Holiday Market)" required value="${v("name")}">
          <label>Date <input name="show_date" type="date" required value="${v("show_date")}"></label>
        </div>
        <div class="row wrap">
          <label>Starts <input name="start_time" type="time" value="${v("start_time")}"></label>
          <label>Ends <input name="end_time" type="time" value="${v("end_time")}"></label>
          <span class="grow"></span>
          ${edit ? `<button type="button" class="sm" data-canceledit>Cancel</button>` : ""}
          <button class="sm go" type="submit">${edit ? "Save" : "Add"}</button>
        </div>
      </form>
    </div>`;
}

function viewShows() {
  const s = state.summary;
  return `
  <div class="page">
    ${state.show ? `
      <div class="card"><strong>${esc(state.show.name)}</strong>
        ${(s?.by_payment || []).map((p) => `<div class="row"><span class="grow">${payLabel(p.payment_method)} (${p.sales} sales)</span><b>${money(p.total_cents)}</b></div>`).join("") || `<p class="muted">No sales yet.</p>`}
        ${s?.discount_cents ? `<div class="row muted"><span class="grow">Discounts given</span>−${money(s.discount_cents)}</div>` : ""}
        ${s?.by_register?.length > 1 ? `<h3>By register</h3>${s.by_register.map((r) => `<div class="row"><span class="grow">${esc(r.register || "(none)")} (${r.sales} sales)</span>${money(r.total_cents)}</div>`).join("")}` : ""}
        ${s?.by_item?.length ? `<h3>Best sellers</h3>${s.by_item.map((i) => `<div class="row"><span class="grow">${esc(i.name)}</span>${i.qty} sold</div>`).join("")}` : ""}
        <p><button class="sm danger" data-endshow="${state.show.id}">End show</button>
        <a href="/api/export?show_id=${state.show.id}"><button class="sm">Download CSV</button></a></p>
      </div>` : ""}
    ${upcomingHTML()}
    <div class="card"><strong>Start an unscheduled show now</strong>
      <div class="row"><input id="showNameIn" class="name" placeholder="Show name (e.g. Holiday Market)"><button class="sm go" data-startshow>Start</button></div></div>
    <h3>Past shows</h3>
    ${state.shows.filter((x) => x.ended_at).map((x) => `
      <div class="card row"><span class="grow">${esc(x.name)}<br><span class="muted">${new Date(x.started_at).toLocaleDateString()}</span></span>
        <a href="/api/export?show_id=${x.id}"><button class="sm">CSV</button></a></div>`).join("") || `<p class="muted">None yet.</p>`}
    <p><a href="/api/export"><button class="sm">Download all sales (CSV)</button></a></p>
  </div>`;
}

// ---------- LOGIN ----------
// Invite-only sign-up, then password + authenticator-app code. The server does the checking
// (src/lib/auth.js); these screens walk through the steps.
const loggedIn = () => state.me?.stage === "ok";
const authState = (view = "login", info = "", extra = {}) =>
  ({ view, info, error: "", email: store.get("lastEmail", ""), invite: "", setup: null, setupFailed: false, ...extra });

function authHTML() {
  const a = state.auth || (state.auth = authState());
  const msgs = (a.error ? `<p class="auth-msg error" role="alert">${esc(a.error)}</p>` : "")
    + (a.info ? `<p class="auth-msg">${esc(a.info)}</p>` : "");
  const card = (title, sub, inner) => `
    <div class="auth"><div class="auth-card">
      <h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ""}${msgs}${inner}
    </div></div>`;
  const codeForm = (label) => `
    <form data-auth="mfa">
      <label>6-digit code<input name="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label>
      <button class="complete" type="submit">${label}</button>
    </form>`;

  if (a.view === "signup") return card("Create your account", "Use the invite code the owner sent you.", `
    <form data-auth="signup">
      <label>Email<input name="email" type="email" autocomplete="username" required value="${esc(a.email)}"></label>
      <label>Invite code<input name="invite" autocomplete="off" autocapitalize="characters" spellcheck="false" required value="${esc(a.invite)}" placeholder="XXXX-XXXX-XXXX"></label>
      <label>New password<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
      <label>Type it again<input name="confirm" type="password" autocomplete="new-password" minlength="10" required></label>
      <p class="muted">At least 10 characters. Next you'll set up your authenticator app.</p>
      <button class="complete" type="submit">Create account</button>
    </form>
    <button class="link" data-authview="login">Already have an account? Log in</button>`);

  if (a.view === "mfa") return card("Enter your code", "Open your authenticator app and type the 6-digit code for Venstock.", `
    ${codeForm("Verify")}
    <button class="link" data-authlogout>Use a different account</button>`);

  if (a.view === "mfa_setup") {
    const s = a.setup;
    return card("Set up two-step login", "Each login needs a code from an app on your phone, so a stolen password alone can't get in.", `
      <ol class="steps">
        <li>Install an authenticator app if you don't have one (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</li>
        <li>In the app, add an account and scan this code.</li>
        <li>Type the 6-digit code the app shows.</li>
      </ol>
      ${s ? `
        <div class="qr" role="img" aria-label="QR code for your authenticator app">${qrSVG(s.uri)}</div>
        <a class="otp-link" href="${esc(s.uri)}">Using this phone? Tap here to add it to your app</a>
        <details><summary>Can't scan? Type the key in by hand</summary>
          <code class="secret">${esc(s.secret.match(/.{1,4}/g).join(" "))}</code>
          <p class="muted">Choose "time-based" if the app asks.</p></details>`
      : a.setupFailed ? `<button class="sm" data-retrysetup>Try again</button>` : `<p class="muted">Loading…</p>`}
      ${codeForm("Turn on and continue")}
      <button class="link" data-authlogout>Cancel and log out</button>`);
  }

  return card("Log in", "", `
    <form data-auth="login">
      <label>Email<input name="email" type="email" autocomplete="username" required value="${esc(a.email)}"></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="complete" type="submit">Log in</button>
    </form>
    <button class="link" data-authview="signup">Got an invite? Create your account</button>
    <p class="muted center">Forgot your password or lost your phone? Ask the owner for a new invite.</p>`);
}

function qrSVG(text) {
  if (typeof qrcode !== "function") return "";
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

function renderAuth() {
  const a = state.auth || (state.auth = authState());
  document.body.dataset.screen = "auth";
  document.body.classList.add("signed-out");
  closeSheet();
  $("#view").innerHTML = authHTML();
  if (a.view === "mfa_setup" && !a.setup && !a.setupFailed && !a.loadingSetup) {
    a.loadingSetup = true;
    api("auth/mfa/setup", { method: "POST", body: {} })
      .then((setup) => { a.setup = setup; })
      .catch((e) => {
        if (e.status === 401) Object.assign(a, authState("login", "That took too long. Please log in again."));
        else { a.setupFailed = true; a.error = errText(e); }
      })
      .finally(() => { a.loadingSetup = false; if (!loggedIn() && state.auth === a) renderAuth(); });
  }
  [...document.querySelectorAll("#view form input")].find((i) => !i.value)?.focus();
}

// Called with the server's answer after each login step.
function signedIn(me) {
  if (!me.support) store.set("lastEmail", me.email);
  if (me.stage !== "ok") {
    state.me = null; store.set("me", null);
    state.auth = authState(me.stage, "", { email: me.email });
    render();
    return;
  }
  state.me = me; store.set("me", me.support ? null : me); // a support session needs a connection: never remembered
  state.auth = null; state.users = null; state.lastInvite = null;
  render(); paintHeader(); sync();
}

function loggedOut(info = "") {
  if (!state.me) return;
  if (inSupport()) return endedSupport();
  state.me = null; store.set("me", null);
  state.auth = authState("login", info);
  if (state.modal) closeModal(false);
  render();
}

async function logOut() {
  const n = state.pending.length;
  if (n && !confirm(`${n} sale${n === 1 ? " hasn't" : "s haven't"} uploaded yet. They stay saved on this device and upload after the next login here. Log out anyway?`)) return;
  try { await api("auth/logout", { method: "POST", body: {} }); }
  catch (e) { if (!e.status) { alert("You're offline. Connect to the internet to log out."); return; } }
  // forget the shop's data on this device (sales not uploaded yet are kept)
  forgetShop();
  resetTxn();
  state.me = null; store.set("me", null);
  state.auth = authState("login", "You're logged out.");
  state.tab = "sell";
  render();
}

async function boot() {
  // invite link: /#invite=CODE&email=...   support link (from the platform admin): /#support=CODE
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("support")) {
    history.replaceState(null, "", location.pathname + location.search);
    try {
      await api("support/enter", { method: "POST", body: { code: h.get("support") } });
      signedIn(await api("auth/me"));
    } catch (e) {
      alert(e.status ? e.message : "You're offline: support sessions need a connection.");
      render();
    }
    return;
  }
  if (h.get("invite")) {
    history.replaceState(null, "", location.pathname + location.search);
    state.me = null; store.set("me", null);
    state.auth = authState("signup", "", { email: h.get("email") || "", invite: h.get("invite") });
    render();
    return;
  }
  render(); // if this device was logged in, the app opens straight away (works offline)
  try {
    signedIn(await api("auth/me"));
  } catch (e) {
    if (e.status === 401) loggedOut("");
    // offline: keep going with what's saved on this device
  }
}

// ---------- ACCOUNT ----------
async function loadUsers() {
  if (!state.me?.is_admin) return;
  try { state.users = await api("users"); state.usersError = ""; }
  catch (e) { state.usersError = errText(e); }
  // Venstock support visits to this shop (not shown inside a support session itself).
  if (!inSupport()) {
    try { state.supportVisits = await api("account/support-sessions"); } catch { state.supportVisits = null; }
  }
  if (state.tab === "account") softRender();
}

function viewAccount() {
  const me = state.me;
  return `
  <div class="page">
    <div class="card row wrap"><span class="grow">Logged in as <b>${esc(me.email)}</b>${me.is_admin ? ` <span class="pill gray">admin</span>` : ""}</span>
      <button class="sm" data-logout>Log out</button></div>
    <div class="card"><strong>Change password</strong>
      <form data-pwform class="stack">
        <input type="email" autocomplete="username" value="${esc(me.email)}" hidden>
        <input name="current" type="password" autocomplete="current-password" placeholder="Current password" required>
        <input name="password" type="password" autocomplete="new-password" placeholder="New password (10+ characters)" minlength="10" required>
        <input name="confirm" type="password" autocomplete="new-password" placeholder="New password again" minlength="10" required>
        <button class="sm go" type="submit">Change password</button>
      </form>
      <p class="muted">Your other devices get logged out when you change it.</p></div>
    ${me.is_admin ? usersCardHTML() : ""}
    ${me.is_admin && !inSupport() ? supportVisitsHTML() : ""}
  </div>`;
}

// Every time Venstock staff looked at this shop's data (read-only, 30 minutes at most, with a reason).
function supportVisitsHTML() {
  const visits = state.supportVisits;
  const when = (v) => (v ? new Date(v).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const live = (v) => !v.ended_at && v.expires_at > Date.now();
  const how = (v) => !v.entered_at ? (live(v) ? "link not used yet" : "link never used")
    : v.ended_at ? `ended ${when(v.ended_at)}` : live(v) ? `happening now, until ${when(v.expires_at)}` : `ran until ${when(v.expires_at)}`;
  return `
  <div class="card"><strong>Venstock support visits</strong>
    <p class="muted">Each time Venstock staff opened your shop to help (read-only, at most 30 minutes, with a reason).</p>
    ${!visits ? `<p class="muted">Loading…</p>` : !visits.length ? `<p class="muted">None.</p>` : visits.map((v) => `
      <div class="row user-row"><span class="grow">${esc(when(v.created_at))} · ${esc(v.staff_email)}<br>
        <span class="muted">${esc(v.reason)}</span><br>
        <span class="muted">${esc(how(v))}${v.entered_at ? ` · ${Number(v.requests) || 0} page${Number(v.requests) === 1 ? "" : "s"} read` : ""}</span></span>
      </div>`).join("")}
  </div>`;
}

function usersCardHTML() {
  const inv = state.lastInvite;
  const link = inv && `${location.origin}/#invite=${encodeURIComponent(inv.invite)}&email=${encodeURIComponent(inv.email)}`;
  return `
  <div class="card"><strong>Who can log in</strong>
    <p class="muted">Only people on this list can make an account. Adding someone gives you an invite link to send them.
      It works once and expires in 7 days. If someone forgets their password or loses their phone, make them a new invite.</p>
    ${inv ? `
      <div class="invite">
        <p>Send this link to <b>${esc(inv.email)}</b>:</p>
        <input class="full" readonly value="${esc(link)}" data-inviteurl>
        <div class="row wrap"><button class="sm go" data-copy="${esc(link)}">Copy link</button>
          <span class="muted">Code: <b>${esc(inv.invite)}</b></span><span class="grow"></span>
          <button class="sm" data-dismissinvite>Done</button></div>
      </div>` : ""}
    ${state.users ? state.users.map((u) => `
      <div class="row user-row"><span class="grow">${esc(u.email)}${u.is_me ? " (you)" : ""}<br>
        <span class="muted">${esc(u.status)}${u.is_admin ? " · admin" : ""}</span></span>
        ${u.is_me ? "" : `<button class="sm" data-reinvite="${u.id}">New invite</button><button class="sm danger" data-deluser="${u.id}">Remove</button>`}
      </div>`).join("")
    : `<p class="muted">${esc(state.usersError || "Loading…")}</p>`}
    <form data-adduser class="row wrap add-user">
      <input name="email" type="email" class="name" placeholder="Their email" required>
      <label><input name="is_admin" type="checkbox"> Admin</label>
      <button class="sm go" type="submit">Add</button>
    </form>
  </div>`;
}

document.addEventListener("submit", async (e) => {
  const f = e.target;
  const v = Object.fromEntries(new FormData(f));

  if (f.dataset.auth) {
    e.preventDefault();
    const a = state.auth;
    f.querySelector('[type="submit"]').disabled = true;
    a.error = ""; a.info = "";
    try {
      if (f.dataset.auth === "login") {
        a.email = v.email.trim();
        signedIn(await api("auth/login", { method: "POST", body: { email: a.email, password: v.password } }));
      } else if (f.dataset.auth === "signup") {
        a.email = v.email.trim(); a.invite = v.invite;
        if (v.password !== v.confirm) throw new Error("The two passwords don't match.");
        signedIn(await api("auth/signup", { method: "POST", body: { email: a.email, invite: v.invite, password: v.password } }));
      } else {
        signedIn(await api("auth/mfa", { method: "POST", body: { code: v.code } }));
      }
    } catch (err) {
      // 401 here = too many wrong codes, or the half-finished login expired: start over
      if (err.status === 401) state.auth = authState("login", "", { error: err.message, email: a.email });
      else a.error = errText(err);
      renderAuth();
    }
    return;
  }

  if (f.dataset.pwform !== undefined) {
    e.preventDefault();
    if (v.password !== v.confirm) { alert("The new passwords don't match."); return; }
    run(() => api("auth/password", { method: "POST", body: { current: v.current, password: v.password } }), "Password changed");
    return;
  }

  if (f.dataset.upcomingform !== undefined) {
    e.preventDefault();
    if (v.start_time && v.end_time && v.end_time <= v.start_time) { alert("The end time needs to be after the start time."); return; }
    const id = state.editUpcoming;
    run(async () => {
      await api(id ? `shows/upcoming/${id}` : "shows/upcoming", { method: id ? "PUT" : "POST", body: v });
      state.editUpcoming = null;
    }, id ? "Saved" : "Show added");
    return;
  }

  if (f.dataset.adduser !== undefined) {
    e.preventDefault();
    run(async () => {
      state.lastInvite = await api("users", { method: "POST", body: { email: v.email.trim(), is_admin: !!v.is_admin } });
      await loadUsers();
    }, "Added — now send them the invite link");
  }
});

// ---------- render + events ----------
function render() {
  document.body.classList.toggle("signed-out", !loggedIn());
  if (!loggedIn()) { renderAuth(); return; }
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
  if (state.tab !== "sell") closeSheet();
  document.body.dataset.screen = state.tab; // not "tab": the click handler treats [data-tab] as a tab button
  $("#view").innerHTML = { sell: viewSell, sales: viewSales, items: viewItems, shows: viewShows, account: viewAccount }[state.tab]();
}

// After background syncs: refresh the screen without wiping what someone is typing.
function softRender() {
  if (!loggedIn()) return;
  if (state.tab === "sell") { paintSell(); return; }
  if (state.modal) return;
  const a = document.activeElement;
  if (a && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName)) return;
  if (state.tab === "items" && state.importPreview) return;
  // something typed but not saved yet (e.g. a half-filled show form): leave the screen alone
  const typed = [...document.querySelectorAll("#view input, #view textarea")].some((i) =>
    i.type === "checkbox" || i.type === "radio" ? i.checked !== i.defaultChecked : i.value !== i.defaultValue);
  if (typed) return;
  render();
}

// An item edit or restock answered 404: the item isn't in this shop's data any more (for example, the shop's data was
// restored from a backup). Say so plainly, and reload the list so the stale item disappears from this screen.
async function itemGone(e) {
  if (e.status !== 404) throw e;
  await refresh().catch(() => {});
  const err = new Error("This item isn't in your shop any more, so the change wasn't saved. The item list has been reloaded.");
  err.status = 404;
  throw err;
}

async function run(fn, okMsg) {
  try { await fn(); await refresh(); state.online = true; if (okMsg) toast(okMsg); }
  catch (e) { if (e.status !== 401) alert(errText(e)); }
  paintHeader(); render();
}

// ---------- light / dark mode ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark";
  const b = $("#themeToggle");
  b.textContent = dark ? "Light" : "Dark";
  b.title = dark ? "Switch to light mode" : "Switch to dark mode";
  b.setAttribute("aria-label", b.title);
  // the browser bar matches the header band (--theme-color in tokens.css)
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--theme-color").trim() || "#8CB9CE";
}
applyTheme(document.documentElement.dataset.theme || "light");
// until someone picks a mode, follow the device's setting
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (!store.get("theme", null)) applyTheme(e.matches ? "dark" : "light");
});

document.addEventListener("click", (e) => {
  const t = e.target.closest("button, [data-tab]");
  if (!t) {
    if (e.target.id === "modal") closeModal(); // tap outside the popup
    return;
  }
  const d = t.dataset;
  if (d.toggletheme !== undefined) {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    store.set("theme", next); applyTheme(next); return;
  }
  if (d.tab) {
    state.tab = d.tab; if (state.modal) closeModal(false); render(); window.scrollTo(0, 0);
    if (d.tab === "account") loadUsers();
    return;
  }

  // login screens + account
  if (d.authview) { state.auth = authState(d.authview, "", { email: state.auth?.email }); renderAuth(); return; }
  if (d.authlogout !== undefined) { api("auth/logout", { method: "POST", body: {} }).catch(() => {}); state.auth = authState("login"); renderAuth(); return; }
  if (d.retrysetup !== undefined) { state.auth.setupFailed = false; state.auth.error = ""; renderAuth(); return; }
  if (d.logout !== undefined) { logOut(); return; }
  if (d.copy) {
    navigator.clipboard?.writeText(d.copy).then(() => toast("Link copied"), () => $("[data-inviteurl]")?.select());
    return;
  }
  if (d.dismissinvite !== undefined) { state.lastInvite = null; render(); return; }
  if (d.reinvite) {
    const u = state.users?.find((x) => x.id == d.reinvite);
    if (!u || !confirm(`Make a new invite for ${u.email}?\n\nThis logs them out everywhere and clears their password and authenticator app. They'll use the new invite to set them up again.`)) return;
    run(async () => { state.lastInvite = await api(`users/${u.id}/invite`, { method: "POST", body: {} }); await loadUsers(); }, "New invite made");
    return;
  }
  if (d.deluser) {
    const u = state.users?.find((x) => x.id == d.deluser);
    if (!u || !confirm(`Remove ${u.email}? They're logged out right away and can't log in again unless you add them back.`)) return;
    run(async () => { await api(`users/${u.id}`, { method: "DELETE" }); await loadUsers(); }, "Removed");
    return;
  }

  // sell screen
  if (d.add) { addToCart(d.add); return; }
  if (d.dec) { state.cart[d.dec] = Math.max(0, (state.cart[d.dec] || 0) - 1); if (!state.cart[d.dec]) delete state.cart[d.dec]; saveTxn(); paintSell(); return; }
  if (d.remove) { delete state.cart[d.remove]; saveTxn(); paintSell(); return; }
  if (d.cat !== undefined) { state.category = d.cat; paintSell(); return; }
  if (d.clear !== undefined) {
    if (cartLines().length && !confirm("Clear all items from this order?")) return;
    state.cart = {}; saveTxn(); paintSell(); return;
  }
  if (d.sheet) { document.body.classList.toggle("sheet-open", d.sheet === "open"); return; }
  if (d.open) { if (d.open === "checkout" && !cartLines().length) return; openModal(d.open); return; }

  // checkout popup
  if (d.close !== undefined) { closeModal(); return; }
  if (d.paymethod) {
    state.payment = d.paymethod; saveTxn();
    document.querySelectorAll("[data-paymethod]").forEach((b) => b.classList.toggle("on", b === t));
    $("#cashBox").innerHTML = cashBoxHTML();
    return;
  }
  if (d.given) { state.cashGiven = (Number(d.given) / 100).toFixed(2); $("#cashBox").innerHTML = cashBoxHTML(); return; }
  if (d.confirm !== undefined) { completeSale(); return; }
  if (d.canceltxn !== undefined) {
    if (!confirm("Cancel this transaction? The order, discount and notes will be cleared.")) return;
    resetTxn(); closeModal(); toast("Transaction cancelled"); return;
  }

  // restock popup
  if (d.saverestock !== undefined) {
    const items = Object.entries(state.restock).map(([id, qty]) => ({ id: Number(id), qty })).filter((i) => i.qty);
    if (!items.length) { toast("Enter a quantity for at least one item."); return; }
    if (items.some((i) => i.qty < 1)) { toast("Restock adds stock: use whole numbers above zero. To lower a count, edit the item."); return; }
    run(async () => {
      await api("items/restock", { method: "POST", body: { items } }).catch(itemGone);
      state.restock = {}; state.restockSearch = ""; closeModal(false);
    }, `Restocked ${items.length} item${items.length === 1 ? "" : "s"}`);
    return;
  }

  if (d.endsupport !== undefined) {
    api("support/end", { method: "POST", body: {} }).catch(() => {}).finally(() => endedSupport());
    return;
  }

  // failed sales
  if (d.failedcsv !== undefined) { downloadText("failed-sales.csv", VenstockSync.failedCsv(state.failed)); return; }
  if (d.failretry !== undefined) {
    const [f] = state.failed.splice(Number(d.failretry), 1);
    if (f) { state.pending.unshift(f.sale); store.set("pending", state.pending); store.set("failed", state.failed); }
    paintHeader(); render(); sync();
    return;
  }
  if (d.failremove !== undefined) {
    const f = state.failed[Number(d.failremove)];
    if (f && confirm("Remove this sale from this device? It was never recorded, so it will be gone for good. Download the CSV first if you need a record.")) {
      state.failed.splice(Number(d.failremove), 1);
      store.set("failed", state.failed);
      paintHeader(); render();
    }
    return;
  }

  // sales
  if (d.salesreg) { state.salesRegister = d.salesreg; render(); return; }
  if (d.void) {
    if (confirm("Cancel this sale? The items go back into stock and it won't count in totals."))
      run(() => api(`sales/${d.void}/void`, { method: "POST", body: {} }), "Sale cancelled");
    return;
  }

  // items
  if (d.additem !== undefined) {
    run(() => api("items", { method: "POST", body: {
      name: $("#newName").value, category: $("#newCat").value, sku: $("#newSku").value,
      price_cents: toCents($("#newPrice").value), stock: parseInt($("#newStock").value || 0, 10) } }), "Item added");
    return;
  }
  if (d.save) {
    const row = document.querySelector(`[data-row="${d.save}"]`);
    const f = (n) => row.querySelector(`[data-f="${n}"]`);
    run(() => api(`items/${d.save}`, { method: "PUT", body: {
      name: f("name").value, category: f("category").value, sku: f("sku").value, price_cents: toCents(f("price").value),
      stock: parseInt(f("stock").value || 0, 10), active: f("active").checked } }).catch(itemGone), "Saved");
    return;
  }
  if (d.template !== undefined) { downloadText("items-template.csv", "name,category,sku,price,stock\nTee - Medium,Apparel,,5.00,1\n"); return; }
  if (d.cancelimport !== undefined) { state.importPreview = null; render(); return; }
  if (d.doimport !== undefined) {
    const p = state.importPreview;
    const mode = document.querySelector('input[name="importMode"]:checked')?.value || "set";
    let res;
    run(async () => {
      res = await api("items/import", { method: "POST", body: { rows: p.rows, mode } });
      state.importPreview = null;
    }).then(() => res && toast(`Imported: ${res.added} new, ${res.updated} updated${res.skipped ? `, ${res.skipped} skipped` : ""}`));
    return;
  }
  if (d.adddeal !== undefined) { $("#dealRows").insertAdjacentHTML("beforeend", dealRowHTML()); return; }
  if (d.deldeal !== undefined) { t.closest(".deal-row").remove(); return; }
  if (d.savedeals !== undefined) {
    const list = [...document.querySelectorAll(".deal-row")].map((r) => ({
      qty: parseInt(r.querySelector('[data-d="qty"]').value, 10) || 0,
      unit_price_cents: toCents(r.querySelector('[data-d="unit"]').value),
      off_cents: toCents(r.querySelector('[data-d="off"]').value),
    })).filter((x) => x.qty || x.unit_price_cents || x.off_cents);
    const bad = list.find((x) => x.qty < 2 || !x.unit_price_cents || !x.off_cents || x.off_cents >= x.qty * x.unit_price_cents);
    if (bad) { alert("Each deal needs: buy 2 or more, an item price, and an amount off that's less than the items cost."); return; }
    run(() => api("settings", { method: "PUT", body: { deals: list } }), "Deals saved");
    return;
  }
  if (d.saveregs !== undefined) {
    run(() => api("settings", { method: "PUT", body: { registers: parseInt($("#regCount").value, 10) || 1 } }), "Registers saved");
    return;
  }

  // shows
  if (d.startupcoming) {
    const u = state.upcoming.find((x) => x.id == d.startupcoming);
    if (!u) return;
    const msg = state.show ? `End “${state.show.name}” and start “${u.name}”?` : `Start “${u.name}” now?`;
    if (confirm(msg)) run(() => api(`shows/upcoming/${u.id}/start`, { method: "POST", body: {} }), "Show started");
    return;
  }
  if (d.editupcoming) {
    state.editUpcoming = Number(d.editupcoming); render();
    $("#upForm")?.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  if (d.canceledit !== undefined) { state.editUpcoming = null; render(); return; }
  if (d.delupcoming) {
    const u = state.upcoming.find((x) => x.id == d.delupcoming);
    if (u && confirm(`Delete “${u.name}” (${whenText(u)}) from upcoming shows?`)) {
      if (state.editUpcoming === u.id) state.editUpcoming = null;
      run(() => api(`shows/upcoming/${u.id}`, { method: "DELETE" }), "Deleted");
    }
    return;
  }
  if (d.startshow !== undefined) { run(() => api("shows", { method: "POST", body: { name: $("#showNameIn").value } }), "Show started"); return; }
  if (d.endshow) { if (confirm("End this show?")) run(() => api(`shows/${d.endshow}/end`, { method: "POST", body: {} }), "Show ended"); }
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "search") { state.search = el.value; $("#grid").innerHTML = gridHTML(); return; }
  if (el.id === "notes" || el.id === "coNotes") { state.notes = el.value; saveTxn(); return; }
  if (el.dataset.discval !== undefined) {
    state.discount.value = el.value; saveTxn();
    $("#totals") && ($("#totals").innerHTML = totalsHTML());
    if (state.modal === "checkout") paintCheckout();
    return;
  }
  if (el.id === "cashGiven") { state.cashGiven = el.value; $("#change").innerHTML = changeText(); return; }
  if (el.id === "rsSearch") { state.restockSearch = el.value; $("#rsList").innerHTML = restockListHTML(); return; }
  if (el.dataset.rs) { const n = parseInt(el.value, 10); if (n) state.restock[el.dataset.rs] = n; else delete state.restock[el.dataset.rs]; return; }
  if (el.id === "itemSearch") {
    state.itemSearch = el.value;
    const q = el.value.trim().toLowerCase();
    $("#itemList").innerHTML = state.items.filter((i) => !q || i.name.toLowerCase().includes(q) || (i.sku || "").toLowerCase().includes(q)
      || (i.category || "").toLowerCase().includes(q)).map(itemRowHTML).join("") || `<p class="muted">No items.</p>`;
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.discount !== undefined) {
    state.discount = { type: el.value, value: "" }; saveTxn();
    // keep the side panel and the checkout popup in step
    if ($("#discountPanel")) $("#discountPanel").innerHTML = discountSelectHTML("discountSel");
    if ($("#coDiscount")) $("#coDiscount").innerHTML = discountSelectHTML("coDiscountSel");
    $("#totals") && ($("#totals").innerHTML = totalsHTML());
    if (state.modal === "checkout") { paintCheckout(); $("#cashBox").innerHTML = cashBoxHTML(); }
    $("[data-discval]")?.focus();
    return;
  }
  if (el.id === "register") { state.register = el.value; store.set("register", el.value); toast(`This device is now ${el.value}`); return; }
  if (el.id === "payment") { state.payment = el.value; saveTxn(); return; }
  if (el.id === "csvFile" && el.files[0]) {
    const file = el.files[0];
    file.text().then((text) => {
      const { rows, warnings } = rowsFromCSV(text);
      state.importPreview = { rows, warnings, fileName: file.name };
      render();
    });
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.modal) closeModal();
  if (e.key === "Enter" && e.target.id === "search") {
    // Enter in search adds the item if exactly one matches (handy for typing a SKU)
    const list = visibleItems();
    if (list.length === 1) { addToCart(list[0].id); e.target.select(); }
  }
});

window.addEventListener("online", sync);
// Refresh often so stock counts stay in step across registers.
setInterval(sync, 15000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");

paintHeader(); boot();
