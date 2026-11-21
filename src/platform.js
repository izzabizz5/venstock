// The Venstock platform admin API, served only at admin.<BASE_DOMAIN>. Called by src/worker.js with the control
// database and nothing else: platform handlers never receive env or any vendor's database.
//
//   /api/auth/*                   platform admin login (platform_admins, platform_sessions, __Host-pos_platform)
//   GET  /api/platform/vendors    the registry
import { makeAuth, PLATFORM_REALM } from "./lib/auth.js";

const { currentSession, authRoutes } = makeAuth(PLATFORM_REALM);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const fail = (error, status = 400) => json({ error }, status);

export async function handlePlatformApi({ request, db, params }) {
  const url = new URL(request.url);
  const [a, b, c] = params.route || [];
  const m = request.method;
  const body = m === "POST" || m === "PUT" ? await request.json().catch(() => ({})) : {};
  try {
    if (a === "auth") return await authRoutes({ db, request, b, c, m, body });
    const sess = await currentSession(db, request);
    if (!sess || !sess.mfa_ok) return fail("Please log in", 401);
    if (a !== "platform") return fail("Not found", 404);

    if (b === "vendors" && !c && m === "GET") {
      const { results } = await db.prepare("SELECT id, slug, name, status, created_at, status_changed_at FROM tenants ORDER BY id").all();
      return json(results);
    }


  } catch (e) {
    console.error(`venstock: 500 platform ${m} ${url.pathname}: ${e?.stack || e}`);
    return fail("Something went wrong", 500);
  }
}

