// The ONLY module that reads the control database binding (CONTROL): the vendor registry, support sessions and the
// audit log. Vendor request handlers never see it; src/lib/tenant.js calls lookup() while resolving a hostname, and
// src/worker.js calls the support-session functions. Platform handlers (src/platform.js) get the control database
// from platformDatabase(), for the admin host only.
//
// Lookups are cached per Worker isolate for REGISTRY_TTL_MS (45 s), "unknown vendor" included, so a flood of requests
// for made-up subdomains doesn't reach the control database. Consequence: suspending, unsuspending or creating a
// vendor takes effect within that window, not instantly.

import { sha256, randomToken } from "./auth.js";

export const REGISTRY_TTL_MS = 45_000;
const MAX_ENTRIES = 10_000; // bounds memory under a flood of distinct made-up slugs (oldest entry is dropped)

// now: injectable clock for tests. Returns { lookup(env, slug) } -> registry row or null.
export function createRegistry({ ttlMs = REGISTRY_TTL_MS, now = Date.now, maxEntries = MAX_ENTRIES } = {}) {
  const cache = new Map();
  return {
    async lookup(env, slug) {
      const t = now();
      const hit = cache.get(slug);
      if (hit && hit.expires > t) return hit.row;
      const row = await env.CONTROL
        .prepare("SELECT id, slug, name, status, db_binding FROM tenants WHERE slug = ?")
        .bind(slug)
        .first();
      cache.delete(slug);
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(slug, { row: row ?? null, expires: t + ttlMs });
      return row ?? null;
    },
    get size() { return cache.size; },
  };
}

// The isolate's registry (src/worker.js uses this one).
export const registry = createRegistry();

// ---------- the platform admin host ----------
// The control database, for admin.<BASE_DOMAIN> only (src/lib/tenant.js decides the host). Platform handlers get
// this and nothing else: never env, never a vendor binding.
export const platformDatabase = (env) => env.CONTROL;

// ---------- support sessions (the vendor-host side; starting one is in src/platform.js) ----------
// A platform admin opens a one-time link at the vendor's own host; that host swaps the code for a host-only cookie
// valid for that vendor only, read-only, until the session ends or its 30 minutes run out.
export const SUPPORT_MINUTES = 30;

// One line in the audit log. detail never holds request bodies.
export async function audit(env, { admin_id = null, tenant_id = null, support_session_id = null, action, detail = "" }) {
  await env.CONTROL
    .prepare("INSERT INTO audit_log (at, admin_id, tenant_id, support_session_id, action, detail) VALUES (?,?,?,?,?,?)")
    .bind(new Date().toISOString(), admin_id, tenant_id, support_session_id, action, String(detail).slice(0, 500))
    .run();
}

const SESSION_COLUMNS = `s.id, s.admin_id, s.tenant_id, s.expires_at, s.entered_at, s.ended_at, a.email AS admin_email
  FROM support_sessions s JOIN platform_admins a ON a.id = s.admin_id`;

// Uses the one-time code from the admin's link, at THIS vendor's host. Returns { token, session } or null.
export async function enterSupport(env, code, tenantId, now = Date.now()) {
  if (typeof code !== "string" || code.length < 20 || code.length > 100) return null;
  const s = await env.CONTROL.prepare(`SELECT ${SESSION_COLUMNS} WHERE s.code_hash = ?`).bind(await sha256(code)).first();
  if (!s) return null;
  if (s.tenant_id !== tenantId || s.ended_at || s.expires_at <= now || s.entered_at) {
    await audit(env, { admin_id: s.admin_id, tenant_id: tenantId, support_session_id: s.id, action: "support.enter.refused",
      detail: s.tenant_id !== tenantId ? `link is for tenant ${s.tenant_id}` : "ended, expired or already used" });
    return null;
  }
  const token = randomToken();
  const r = await env.CONTROL
    .prepare("UPDATE support_sessions SET code_hash = NULL, token_hash = ?, entered_at = ? WHERE id = ? AND code_hash IS NOT NULL")
    .bind(await sha256(token), new Date(now).toISOString(), s.id)
    .run();
  if (!r.meta.changes) return null; // the same link used twice at once: only one wins
  await audit(env, { admin_id: s.admin_id, tenant_id: s.tenant_id, support_session_id: s.id, action: "support.enter" });
  return { token, session: s };
}

// The live support session behind this cookie value, for THIS vendor, or null.
export async function supportSession(env, token, tenantId, now = Date.now()) {
  if (!token) return null;
  const s = await env.CONTROL.prepare(`SELECT ${SESSION_COLUMNS} WHERE s.token_hash = ?`).bind(await sha256(token)).first();
  if (!s || s.tenant_id !== tenantId || s.ended_at || s.expires_at <= now) return null;
  return s;
}

// Ends the session behind this cookie value (the banner's "End" button). Harmless if it already ended.
export async function endSupport(env, token, tenantId) {
  const s = await supportSession(env, token, tenantId);
  if (!s) return;
  await env.CONTROL.prepare("UPDATE support_sessions SET ended_at = ?, ended_by = 'vendor-host' WHERE id = ? AND ended_at IS NULL")
    .bind(new Date().toISOString(), s.id).run();
  await audit(env, { admin_id: s.admin_id, tenant_id: s.tenant_id, support_session_id: s.id, action: "support.end", detail: "ended from the vendor's host" });
}
