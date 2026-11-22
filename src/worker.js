// Worker entry point. wrangler.toml sets run_worker_first = true, so every request comes here first and is matched to
// one vendor by its hostname (src/lib/tenant.js):
//   - unknown, reserved, deleted or malformed host: 404 for everything, the app shell included;
//   - registry or binding wired wrong: 500 for everything, details only in the log;
//   - vendor still being set up (provisioning, or its database isn't bound in this deploy yet): 503 for everything;
//   - suspended vendor: the app shell is served (so the app can say so and the vendor can export failed sales),
//     every /api request gets 403;
//   - active vendor: /api goes to the API with ONLY that vendor's database; everything else is a static file;
//   - admin.<BASE_DOMAIN>: the platform admin page and API (src/platform.js), with ONLY the control database.
// Support sessions (a platform admin looking at one vendor, read-only, 30 minutes) live on the vendor's own host:
// /api/support/enter swaps the one-time code for a __Host-pos_support cookie; with that cookie, only GET reaches the
// API, through a read-only database, and every request is written to the audit log.
import { handleApi } from "./api.js";
import { handlePlatformApi } from "./platform.js";
import { resolveVendor } from "./lib/tenant.js";
import { enterSupport, supportSession, endSupport, audit } from "./lib/control.js";
import { readCookie, sessionCookie, SUPPORT_COOKIE, clientDescription } from "./lib/auth.js";
import { readOnlyDb } from "./lib/readonly-db.js";


const isApi = (path) => path === "/api" || path.startsWith("/api/");
const NO_STORE = { "cache-control": "no-store" };

function plain(status, text, api, apiError) {
  return api
    ? Response.json({ error: apiError ?? text }, { status, headers: NO_STORE })
    : new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE } });
}

const SETTING_UP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setting up</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1>This shop is being set up</h1>
<p>It will be ready in a few minutes. Please try again shortly.</p>
</body></html>`;

export default {
  async fetch(request, env) {
    try {
      return await serve(request, env);
    } catch (e) {
      // Anything unexpected (e.g. the control database unreachable): a generic answer, details only in the log.
      const url = new URL(request.url);
      console.error(`venstock: 500 ${request.method} ${url.hostname}${url.pathname}: ${e?.stack || e}`);
      return plain(500, "Something went wrong", isApi(url.pathname));
    }
  },
};

// Forged requests from another origin, including sibling subdomains (same-site, so SameSite=Strict cookies still go
// with them). Every request that can change something (anything but GET/HEAD) must:
//   - not come from another origin: if the browser says where it came from (Sec-Fetch-Site), it must be same-origin;
//   - carry Content-Type: application/json. A cross-origin page can only send that after a CORS preflight, which
//     this Worker never approves, so older browsers without Sec-Fetch-Site are covered too.
// Returns the refusal, or null.
const SAFE_METHODS = new Set(["GET", "HEAD"]);
export function refuseForgedRequest(request) {
  if (SAFE_METHODS.has(request.method)) return null;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") {
    return Response.json({ error: "Requests from other sites are not allowed" }, { status: 403, headers: NO_STORE });
  }
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return Response.json({ error: "Send JSON (Content-Type: application/json)" }, { status: 415, headers: NO_STORE });
  }
  return null;
}

async function serve(request, env) {
  const forged = refuseForgedRequest(request);
  if (forged) return forged;
  const url = new URL(request.url);
  const api = isApi(url.pathname);
  const v = await resolveVendor(env, url.hostname);

  switch (v.kind) {
    case "notFound":
      return plain(404, "Not found", api);
    case "refused":
      console.error(`venstock: refused ${url.hostname}: ${v.reason}`);
      return plain(500, "Something went wrong", api);
    case "settingUp":
      return api
        ? Response.json({ error: "This shop is being set up. Try again in a few minutes." }, { status: 503, headers: { ...NO_STORE, "retry-after": "120" } })
        : new Response(SETTING_UP_PAGE, { status: 503, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE, "retry-after": "120" } });
    case "suspended":
      if (!api && /^\/admin(\.html|\.js)?$/.test(url.pathname)) return plain(404, "Not found", false);
      if (!api) return env.ASSETS.fetch(request);
      return Response.json({ error: "This account is suspended. Contact Venstock support." }, { status: 403, headers: NO_STORE });
    case "platform": {
      // The platform admin page; everything else (script, styles) is an ordinary static file.
      if (!api) return noFraming(await env.ASSETS.fetch(url.pathname === "/" || url.pathname === "/index.html" ? new Request(new URL("/admin", url), request) : request));
      const route = apiRoute(url);
      if (!route) return Response.json({ error: "Not found" }, { status: 404 });
      return handlePlatformApi({ request, db: v.db, params: { route } });
    }
    case "active":
      break;
    default:
      console.error(`venstock: unexpected resolver result ${v.kind}`);
      return plain(500, "Something went wrong", api);
  }

  // The platform admin page belongs to admin.<BASE_DOMAIN> only.
  if (!api && /^\/admin(\.html|\.js)?$/.test(url.pathname)) return plain(404, "Not found", false);
  if (!api) return env.ASSETS.fetch(request);
  const route = apiRoute(url);
  if (!route) return Response.json({ error: "Not found" }, { status: 404 });

  // ---------- support sessions (this vendor's host only) ----------
  if (route[0] === "support") return supportRoutes(request, env, v.tenant, route);
  const supportToken = readCookie(request, SUPPORT_COOKIE);
  if (supportToken) {
    const s = await supportSession(env, supportToken, v.tenant.id);
    if (!s) return Response.json({ error: "This support session has ended." }, { status: 401, headers: { ...NO_STORE, "set-cookie": sessionCookie(SUPPORT_COOKIE, "", 0) } });
    const where = `${request.method} ${url.pathname}${url.search}`; // the query too (?show_id=…), never the body
    if (request.method !== "GET") {
      await audit(env, { admin_id: s.admin_id, tenant_id: s.tenant_id, support_session_id: s.id, action: "support.denied", detail: where });
      return Response.json({ error: "Support sessions are read-only." }, { status: 403, headers: NO_STORE });
    }
    await audit(env, { admin_id: s.admin_id, tenant_id: s.tenant_id, support_session_id: s.id, action: "support.request", detail: where });
    return handleApi({ request, db: readOnlyDb(v.db), tenant: v.tenant, params: { route }, support: { admin_email: s.admin_email, expires_at: s.expires_at } });
  }

  // Only this vendor's database and registry row. The real env (CONTROL, other vendors' bindings) stays here.
  return handleApi({ request, db: v.db, tenant: v.tenant, params: { route } });
}

// The admin host's files may never be shown inside another site's frame (clicks on End or Log out tricked out of
// a staff member).
function noFraming(res) {
  const out = new Response(res.body, res);
  out.headers.set("x-frame-options", "DENY");
  out.headers.set("content-security-policy", "frame-ancestors 'none'");
  return out;
}

// The decoded path segments after /api (the same shape Pages Functions gave [[route]].js), or null if undecodable.
function apiRoute(url) {
  try {
    return url.pathname.slice(4).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

// POST /api/support/enter { code }: the one-time code from the admin's link, for THIS vendor only.
// POST /api/support/end: the banner's End button.
async function supportRoutes(request, env, tenant, route) {
  const [, action] = route;
  if (action === "enter" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const entered = await enterSupport(env, body.code, tenant.id, { client: clientDescription(request) });
    if (!entered) return Response.json({ error: "That support link is invalid, already used or expired." }, { status: 400, headers: NO_STORE });
    const seconds = Math.max(1, Math.floor((entered.session.expires_at - Date.now()) / 1000));
    return Response.json({ ok: true, expires_at: entered.session.expires_at },
      { headers: { ...NO_STORE, "set-cookie": sessionCookie(SUPPORT_COOKIE, entered.token, seconds) } });
  }
  if (action === "end" && request.method === "POST") {
    await endSupport(env, readCookie(request, SUPPORT_COOKIE), tenant.id);
    return Response.json({ ok: true }, { headers: { ...NO_STORE, "set-cookie": sessionCookie(SUPPORT_COOKIE, "", 0) } });
  }
  return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
}

