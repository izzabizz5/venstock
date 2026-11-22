// The Venstock platform admin API, served only at admin.<BASE_DOMAIN>. Called by src/worker.js with the control
// database and nothing else: platform handlers never receive env or any vendor's database. Looking at a vendor's
// data is only possible through a support session, which happens at that vendor's own host (see src/worker.js).
//
//   /api/auth/*                   platform admin login (platform_admins, platform_sessions, __Host-pos_platform)
//   GET  /api/platform/vendors    the registry
//   GET  /api/platform/support    recent support sessions
//   POST /api/platform/support    { slug, reason } -> a 30-minute, read-only support session and its one-time link
//   POST /api/platform/support/<id>/end
//   GET  /api/platform/audit      the latest audit log entries
import { makeAuth, PLATFORM_REALM, sha256, randomToken, clientDescription } from "./lib/auth.js";
import { SUPPORT_MINUTES, LINK_SECONDS } from "./lib/control.js";

const { currentSession, authRoutes } = makeAuth(PLATFORM_REALM);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (error, status = 400) => json({ error }, status);

export async function handlePlatformApi({ request, db, params }) {
  const url = new URL(request.url);
  const [a, b, c, d] = params.route || [];
  const m = request.method;
  const body = m === "POST" || m === "PUT" ? await request.json().catch(() => ({})) : {};
  try {
    if (a === "auth") {
      const before = m === "POST" ? await currentSession(db, request) : null; // a step may end this session
      const r = await authRoutes({ db, request, b, c, m, body });
      if (m === "POST") await auditLogin(db, request, { b, c, body, before, ok: r.ok, status: r.status });
      return r;
    }
    const sess = await currentSession(db, request);
    if (!sess || !sess.mfa_ok) return fail("Please log in", 401);
    if (a !== "platform") return fail("Not found", 404);

    if (b === "vendors" && !c && m === "GET") {
      const { results } = await db.prepare("SELECT id, slug, name, status, created_at, status_changed_at FROM tenants ORDER BY id").all();
      return json(results);
    }

    if (b === "support" && !c && m === "GET") {
      const { results } = await db.prepare(
        `SELECT s.id, t.slug, t.name AS vendor, a.email AS admin_email, s.reason, s.created_at, s.expires_at, s.entered_at,
                s.ended_at, s.ended_by
         FROM support_sessions s JOIN tenants t ON t.id = s.tenant_id JOIN platform_admins a ON a.id = s.admin_id
         ORDER BY s.id DESC LIMIT 50`
      ).all();
      const now = Date.now();
      return json(results.map((s) => ({ ...s, active: !s.ended_at && s.expires_at > now })));
    }

    if (b === "support" && !c && m === "POST") {
      const slug = String(body.slug ?? "").trim().toLowerCase();
      const reason = String(body.reason ?? "").trim();
      if (reason.length < 5 || reason.length > 500) return fail("Write why you need to look (5 to 500 characters).");
      const tenant = await db.prepare("SELECT id, slug, status FROM tenants WHERE slug = ?").bind(slug).first();
      if (!tenant || tenant.status !== "active") return fail("No active vendor with that name.", 404);
      const code = randomToken(24);
      const expires = Date.now() + SUPPORT_MINUTES * 60 * 1000;
      const now = new Date().toISOString();
      const r = await db.prepare(
        "INSERT INTO support_sessions (admin_id, tenant_id, reason, code_hash, created_at, expires_at) VALUES (?,?,?,?,?,?)"
      ).bind(sess.id, tenant.id, reason, await sha256(code), now, expires).run();
      const id = r.meta.last_row_id;
      await auditRow(db, { admin_id: sess.id, tenant_id: tenant.id, support_session_id: id, action: "support.start", detail: reason });
      // The vendor's host is this host with "admin." replaced by the vendor's slug (same scheme and port).
      const vendorHost = url.host.replace(/^admin\./, `${tenant.slug}.`);
      // The code goes in the URL fragment: browsers never send it to a server, never put it in a Referer header,
      // and it never appears in request logs. The vendor page removes it from the address bar and POSTs it.
      // link_seconds lets the admin page count down from when it got the link, whatever the staff computer's clock says.
      return json({ id, expires_at: expires, link_expires_at: Date.now() + LINK_SECONDS * 1000, link_seconds: LINK_SECONDS, url:`${url.protocol}//${vendorHost}/#support=${code}` });
    }

    if (b === "support" && c && d === "end" && m === "POST") {
      const s = await db.prepare("SELECT id, tenant_id, ended_at FROM support_sessions WHERE id = ?").bind(Number(c) || 0).first();
      if (!s) return fail("Not found", 404);
      if (!s.ended_at) {
        await db.prepare("UPDATE support_sessions SET ended_at = ?, ended_by = 'admin' WHERE id = ? AND ended_at IS NULL")
          .bind(new Date().toISOString(), s.id).run();
        await auditRow(db, { admin_id: sess.id, tenant_id: s.tenant_id, support_session_id: s.id, action: "support.end", detail: "ended by a platform admin" });
      }
      return json({ ok: true });
    }

    if (b === "audit" && !c && m === "GET") {
      const { results } = await db.prepare(
        `SELECT l.id, l.at, l.action, l.detail, l.support_session_id, a.email AS admin_email, t.slug
         FROM audit_log l LEFT JOIN platform_admins a ON a.id = l.admin_id LEFT JOIN tenants t ON t.id = l.tenant_id
         ORDER BY l.id DESC LIMIT 200`
      ).all();
      return json(results);
    }

    return fail("Not found", 404);
  } catch (e) {
    console.error(`venstock: 500 platform ${m} ${url.pathname}: ${e?.stack || e}`);
    return fail("Something went wrong", 500);
  }
}

// Every staff login step (password, 6-digit code, sign-up, password change, logout), succeeded or not: who (when
// known), the email typed at the password and sign-up steps, the answer's status and the client. Never a password,
// code or invite.
async function auditLogin(db, request, { b, c, body, before, ok, status }) {
  const step = [b, c].filter(Boolean).join(".");
  let typed = "", adminId = before?.id ?? null;
  if (b === "login" || b === "signup") {
    // Only something shaped like an email: a password typed into the email box must never reach the log.
    const email = String(body.email ?? "").trim().slice(0, 200);
    typed = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `${email}; ` : "(not an email); ";
    if (typed !== "(not an email); ") adminId = (await db.prepare("SELECT id FROM platform_admins WHERE email = ?").bind(email).first())?.id ?? null;
  }
  await auditRow(db, { admin_id: adminId, tenant_id: null, support_session_id: null,
    action: `platform.${step}${ok ? "" : ".failed"}`, detail: `${typed}status ${status}; ${clientDescription(request)}` });
}

const auditRow = (db, { admin_id, tenant_id, support_session_id, action, detail }) =>
  db.prepare("INSERT INTO audit_log (at, admin_id, tenant_id, support_session_id, action, detail) VALUES (?,?,?,?,?,?)")
    .bind(new Date().toISOString(), admin_id, tenant_id, support_session_id, action, String(detail).slice(0, 500)).run();
