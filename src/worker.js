// Worker entry point. /api requests go to the API; everything else is a static file from public/.
// wrangler.toml sets run_worker_first = true, so this runs for every request (tenant checks land here in step 4).
import { handleApi } from "./api.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      // Same shape Pages Functions gave [[route]].js: the decoded path segments after /api.
      let route;
      try {
        route = url.pathname.slice(4).split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return handleApi({ request, env, params: { route } });
    }
    return env.ASSETS.fetch(request);
  },
};
