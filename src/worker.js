// Worker entry point. wrangler.toml sets run_worker_first = true, so every request comes here first and is matched to
// one vendor by its hostname (src/lib/tenant.js):
//   - unknown, reserved, deleted or malformed host: 404 for everything, the app shell included;
//   - registry or binding wired wrong: 500 for everything, details only in the log;
//   - vendor still being set up (provisioning, or its database isn't bound in this deploy yet): 503 for everything;
//   - suspended vendor: the app shell is served (so the app can say so and the vendor can export failed sales),
//     every /api request gets 403;
//   - active vendor: /api goes to the API with ONLY that vendor's database; everything else is a static file.
import { handleApi } from "./api.js";
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
        if (!api) return env.ASSETS.fetch(request);
        return Response.json({ error: "This account is suspended. Contact Venstock support." }, { status: 403, headers: NO_STORE });
      case "active":
        break;
      default:
        console.error(`venstock: unexpected resolver result ${v.kind}`);
        return plain(500, "Something went wrong", api);
    }

    if (!api) return env.ASSETS.fetch(request);
    // The decoded path segments after /api (the same shape Pages Functions gave [[route]].js).
    let route;
    try {
      route = url.pathname.slice(4).split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // INTERIM: handleApi still reads env.DB, so it gets a stand-in env holding ONLY this vendor's database. The real
    // env (CONTROL, other vendors' bindings) never reaches a handler. Steps 7-8 change handlers to take { db, tenant }.
    return handleApi({ request, env: { DB: v.db }, params: { route }, tenant: v.tenant });
  },
};
