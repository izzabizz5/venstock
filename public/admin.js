// Venstock platform admin (admin.<BASE_DOMAIN>): staff login and the vendor list.
// No offline mode and no service worker: this page only works online. Every request is JSON (see src/worker.js).
"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let me = null, flash = "", data = { vendors: [] };

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
  data = { vendors: await api("platform/vendors") };
}

function dashboard() {
  $("#who").textContent = me.email;
  view(`<div class="page">${note()}
    <h2>Vendors</h2>
    ${data.vendors.map((v) => `<div class="card"><div class="row"><span class="grow"><strong>${esc(v.slug)}</strong> · ${esc(v.name)}</span>
      <span class="pill">${esc(v.status)}</span></div></div>`).join("") || `<p class="muted">No vendors yet.</p>`}
    <p><button class="link" data-logout>Log out</button></p></div>`);
}

async function render() {
  if (!me) return loginView();
  if (me.stage !== "ok") return mfaView();
  try { await load(); } catch (e) { if (e.status === 401) { me = null; return loginView(); } flash = e.message; }
  dashboard();
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.logout !== undefined) {
    await api("auth/logout", { method: "POST", body: {} }).catch(() => {});
    me = null; render();
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
