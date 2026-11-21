// The ONLY module that reads the control database binding (CONTROL): the vendor registry. Vendor request handlers
// never see it; src/lib/tenant.js calls lookup() while resolving a hostname. Platform handlers (src/platform.js) get
// the control database from platformDatabase(), for the admin host only.
//
// Lookups are cached per Worker isolate for REGISTRY_TTL_MS (45 s), "unknown vendor" included, so a flood of requests
// for made-up subdomains doesn't reach the control database. Consequence: suspending, unsuspending or creating a
// vendor takes effect within that window, not instantly.

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
