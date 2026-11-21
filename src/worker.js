// Worker entry point. wrangler.toml sets run_worker_first = true, so every request comes here first and is matched to
// one vendor by its hostname (src/lib/tenant.js):
//   - unknown, reserved, deleted or malformed host: 404 for everything, the app shell included;
//   - registry or binding wired wrong: 500 for everything, details only in the log;
//   - vendor still being set up (provisioning, or its database isn't bound in this deploy yet): 503 for everything;
//   - suspended vendor: the app shell is served (so the app can say so and the vendor can export failed sales),
//     every /api request gets 403;
//   - active vendor: /api goes to the API with ONLY that vendor's database; everything else is a static file;
//   - admin.<BASE_DOMAIN>: the platform admin page and API (src/platform.js), with ONLY the control database.
import { handleApi } from "./api.js";
import { handlePlatformApi } from "./platform.js";
import { resolveVendor } from "./lib/tenant.js";


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
      if (!api) return env.ASSETS.fetch(url.pathname === "/" || url.pathname === "/index.html" ? new Request(new URL("/admin", url), request) : request);
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

  // Only this vendor's database and registry row. The real env (CONTROL, other vendors' bindings) stays here.
  return handleApi({ request, db: v.db, tenant: v.tenant, params: { route } });
}

// The decoded path segments after /api (the same shape Pages Functions gave [[route]].js), or null if undecodable.
function apiRoute(url) {
  try {
    return url.pathname.slice(4).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}


