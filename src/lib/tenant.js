// Which vendor (tenant) a request is for, and which database serves it. The ONLY place that reads a vendor binding
// out of env (env[`DB_T<id>`]); request handlers get just the one database this returns.
//
//   hostname -> slug (<slug>.<BASE_DOMAIN>, exactly one level deep, reserved slugs refused)
//            -> registry row (control database, via src/lib/control.js)
//            -> binding DB_T<id>, derived from the numeric id and required to equal tenants.db_binding
//            -> env[binding], whose vendor_identity row must name this same vendor (checked once per isolate)
import { registry as defaultRegistry } from "./control.js";

// Never a vendor slug. "admin" will serve the platform admin; the rest are kept for the product.
export const RESERVED_SLUGS = new Set([
  "admin", "www", "api", "app", "support", "status", "mail", "help", "docs",
  "login", "static", "assets", "cdn", "dev", "staging",
]);

// One DNS label: lowercase letters, digits and inner hyphens, 1-63 characters.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Pure: { kind: "tenant", slug } | { kind: "reserved", slug } | { kind: "none" }.
export function parseHost(hostname, baseDomain) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const base = String(baseDomain || "").toLowerCase().replace(/^\.|\.$/g, "");
  if (!base || !host.endsWith("." + base)) return { kind: "none" };
  const slug = host.slice(0, -(base.length + 1));
  if (!LABEL.test(slug)) return { kind: "none" }; // empty, or more than one level (contains a dot), or bad characters
  return RESERVED_SLUGS.has(slug) ? { kind: "reserved", slug } : { kind: "tenant", slug };
}

// The binding name for a vendor's database. Only ever derived from the registry's numeric id.
export const vendorBinding = (id) => `DB_T${id}`;

// Vendors whose database has passed the identity check in this isolate (by tenant id).
const VERIFIED = new Set();

// Result kinds (src/worker.js turns each into a response):
//   notFound   unknown, reserved, deleted or malformed host: 404 everywhere
//   refused    the registry or the binding is wired wrong: 500, logged (reason is for the log only)
//   settingUp  provisioning, or no binding deployed yet: 503 everywhere
//   suspended  app shell only; the API answers 403
//   active     { tenant, db }
export async function resolveVendor(env, hostname, { registry = defaultRegistry, verified = VERIFIED } = {}) {
  const parsed = parseHost(hostname, env.BASE_DOMAIN);
  if (parsed.kind !== "tenant") return { kind: "notFound" };
  const row = await registry.lookup(env, parsed.slug);
  if (!row || row.status === "deleted") return { kind: "notFound" };

  if (!Number.isInteger(row.id) || row.id < 1) return { kind: "refused", reason: `bad tenant id ${row.id} for ${row.slug}` };
  const binding = vendorBinding(row.id);
  if (row.db_binding !== binding) {
    return { kind: "refused", reason: `tenant ${row.id} (${row.slug}) has db_binding ${row.db_binding}, expected ${binding}` };
  }
  const tenant = { id: row.id, slug: row.slug, name: row.name, status: row.status };
  if (row.status === "provisioning") return { kind: "settingUp", tenant };
  if (row.status === "suspended") return { kind: "suspended", tenant };
  if (row.status !== "active") return { kind: "refused", reason: `tenant ${row.id} has unknown status ${row.status}` };

  const db = env[binding];
  if (!db) return { kind: "settingUp", tenant };
  if (!verified.has(row.id)) {
    let rows;
    try {
      ({ results: rows } = await db.prepare("SELECT tenant_id, slug FROM vendor_identity").all());
    } catch (e) {
      return { kind: "refused", reason: `${binding} has no readable vendor_identity: ${e.message}` };
    }
    if (rows.length !== 1 || rows[0].tenant_id !== row.id || rows[0].slug !== row.slug) {
      return { kind: "refused", reason: `${binding} identifies as ${JSON.stringify(rows)}, not tenant ${row.id} (${row.slug})` };
    }
    verified.add(row.id);
  }
  return { kind: "active", tenant, db };
}
