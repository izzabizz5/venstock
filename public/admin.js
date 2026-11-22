// Venstock platform admin (admin.<BASE_DOMAIN>): staff login, the vendor list, support sessions and the audit log.
// No offline mode and no service worker: this page only works online. Every request is JSON (see src/worker.js).
"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (v) => (v ? new Date(v).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
let me = null, flash = "", data = { vendors: [], support: [], audit: [] }, lastLink = null;

async function api(path, opts = {}) {
  const r = await fetch("/api/" + path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(out.error || `Error ${r.status}`); e.status = r.status; throw e; }
  return out;
}

function qrSVG(text) {
  if (typeof qrcode !== "function") return "";
  const q = qrcode(0, "M"); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

function view(html) { $("#view").innerHTML = html; }
const note = () => (flash ? `<div class="notice">${esc(flash)}</div>` : "");

function loginView(invite) {
  $("#who").textContent = "";
  if (invite) {
    view(`<div class="page">${note()}<h2>Set your password</h2>
      <form id="signup"><input id="email" type="email" value="${esc(invite.email)}" placeholder="Email" required>
      <input id="code" value="${esc(invite.code)}" placeholder="Invite code" required>
      <input id="pw" type="password" placeholder="New password (10+ characters)" required>
      <button>Continue</button></form></div>`);
    $("#signup").onsubmit = (e) => { e.preventDefault(); step(() => api("auth/signup", { method: "POST", body: { email: $("#email").value, invite: $("#code").value, password: $("#pw").value } })); };
    return;
  }
  view(`<div class="page">${note()}<h2>Venstock staff login</h2>
    <form id="login"><input id="email" type="email" placeholder="Email" required>
    <input id="pw" type="password" placeholder="Password" required><button>Log in</button></form></div>`);
  $("#login").onsubmit = (e) => { e.preventDefault(); step(() => api("auth/login", { method: "POST", body: { email: $("#email").value, password: $("#pw").value } })); };
}

async function mfaView() {
  let setup = "";
  if (me.stage === "mfa_setup") {
    try {
      const s = await api("auth/mfa/setup", { method: "POST", body: {} });
      setup = `<p>Scan this with your authenticator app, then enter the 6-digit code.</p>${qrSVG(s.uri)}<p class="muted">Key: ${esc(s.secret)}</p>`;
    } catch (e) { flash = e.message; }
  }
  view(`<div class="page">${note()}<h2>6-digit code</h2>${setup}
    <form id="mfa"><input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required><button>Continue</button></form></div>`);
  $("#mfa").onsubmit = (e) => { e.preventDefault(); step(() => api("auth/mfa", { method: "POST", body: { code: $("#code").value } })); };
}

async function step(fn) {
  try { me = await fn(); flash = ""; } catch (e) { flash = e.message; }
  render();
}

async function load() {
  const [vendors, support, audit] = await Promise.all([api("platform/vendors"), api("platform/support"), api("platform/audit")]);
  data = { vendors, support, audit };
}

// The one-time support link works for link_seconds after the server made it. Count down from when this page got
// it (not from link_expires_at, which is in the server's clock), minus a little for the trip to the vendor's host.
const LINK_MARGIN_MS = 2000;
let linkTimer = null;
const linkSecondsLeft = () => Math.max(0, Math.ceil((lastLink.deadline - Date.now()) / 1000));

function linkCard() {
  if (!lastLink) return "";
  const head = `<strong>Support link for ${esc(lastLink.slug)}</strong>`;
  if (lastLink.opened) return `${head}<p class="muted">Opened in a new tab. The link works only once: to look again, start a new support session.</p>`;
  const left = linkSecondsLeft();
  if (!left) return `${head}<p class="warn">Link expired: it must be opened within ${esc(lastLink.link_seconds)} seconds. Start a new support session.</p>`;
  return `${head}<p class="muted">Open it now: <strong class="warn">${left} s left</strong>. It works once, and opens ${esc(lastLink.slug)}'s own site, read-only, until ${esc(when(lastLink.expires_at))}.</p>
    <a href="${esc(lastLink.url)}" target="_blank" rel="noopener" data-openlink><button class="sm">Open support session</button></a>`;
}

// Redraws only the link card (once a second while the link is usable), never the whole page.
function paintLinkCard() {
  const el = document.getElementById("supportLink");
  if (el) el.innerHTML = linkCard();
  const live = lastLink && !lastLink.opened && linkSecondsLeft() > 0;
  if (live && !linkTimer) linkTimer = setInterval(paintLinkCard, 1000);
  if (!live && linkTimer) { clearInterval(linkTimer); linkTimer = null; }
}

function dashboard() {
  $("#who").textContent = me.email;
  const link = lastLink ? `<div class="card" id="supportLink">${linkCard()}</div>` : "";
  view(`<div class="page">${note()}${link}
    <h2>Vendors</h2>
    ${data.vendors.map((v) => `<div class="card"><div class="row"><span class="grow"><strong>${esc(v.slug)}</strong> · ${esc(v.name)}</span>
      <span class="pill">${esc(v.status)}</span>
      ${v.status === "active" ? `<button class="sm" data-support="${esc(v.slug)}">Support session</button>` : ""}</div></div>`).join("") || `<p class="muted">No vendors yet.</p>`}
    <h2>Support sessions</h2>
    ${data.support.map((s) => `<div class="card"><div class="row"><span class="grow"><strong>${esc(s.slug)}</strong> · ${esc(s.admin_email)} · ${esc(when(s.created_at))}</span>
      ${s.active ? `<button class="sm danger" data-end="${s.id}">End</button>` : `<span class="pill gray">${s.ended_at ? `ended (${esc(s.ended_by)})` : "expired"}</span>`}</div>
      <div class="muted">${esc(s.reason)}</div></div>`).join("") || `<p class="muted">None yet.</p>`}
    <h2>Audit log</h2>
    ${data.audit.map((l) => `<div class="muted">${esc(when(l.at))} · ${esc(l.action)} · ${esc(l.admin_email || "")} · ${esc(l.slug || "")} · ${esc(l.detail)}</div>`).join("") || `<p class="muted">Empty.</p>`}
    <p><button class="link" data-logout>Log out</button></p></div>`);
  paintLinkCard();
}

async function render() {
  if (!me) return loginView();
  if (me.stage !== "ok") return mfaView();
  try { await load(); } catch (e) { if (e.status === 401) { me = null; return loginView(); } flash = e.message; }
  dashboard();
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-openlink]")) {
    // Let the browser open the link first; then the card says it was used (it works only once).
    setTimeout(() => { if (lastLink) { lastLink.opened = true; paintLinkCard(); } }, 0);
    return;
  }
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.support) {
    const reason = prompt(`Why do you need to look at ${t.dataset.support}'s data? (recorded in the audit log)`);
    if (!reason) return;
    try {
      const r = await api("platform/support", { method: "POST", body: { slug: t.dataset.support, reason } });
      lastLink = { ...r, slug: t.dataset.support, deadline: Date.now() + r.link_seconds * 1000 - LINK_MARGIN_MS }; flash = "";
    } catch (err) { flash = err.message; }
    render();
  } else if (t.dataset.end) {
    try { await api(`platform/support/${t.dataset.end}/end`, { method: "POST", body: {} }); } catch (err) { flash = err.message; }
    render();
  } else if (t.dataset.logout !== undefined) {
    await api("auth/logout", { method: "POST", body: {} }).catch(() => {});
    me = null; lastLink = null; paintLinkCard(); render();
  }
});

(async function boot() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("invite")) {
    history.replaceState(null, "", location.pathname);
    return loginView({ code: h.get("invite"), email: h.get("email") || "" });
  }
  try { me = await api("auth/me"); } catch { me = null; }
  render();
})();
