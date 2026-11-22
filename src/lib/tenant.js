// Which vendor (tenant) a request is for, and which database serves it. The ONLY place that reads a vendor binding
// out of env (env[`DB_T<id>`]); request handlers get just the one database this returns.
//
//   hostname -> slug (<slug>.<BASE_DOMAIN>, exactly one level deep, reserved slugs refused)
//            -> registry row (control database, via src/lib/control.js)
//            -> binding DB_T<id>, derived from the numeric id and required to equal tenants.db_binding
//            -> env[binding], whose vendor_identity row must name this same vendor (checked once per isolate)
import { registry as defaultRegistry, platformDatabase } from "./control.js";

// Never a vendor slug. "admin" will serve the platform admin; the rest are kept for the product.
export const RESERVED_SLUGS = new Set([
  "admin", "www", "api", "app", "support", "status", "mail", "help", "docs",
  "login", "static", "assets", "cdn", "dev", "staging",
]);

// A vendor slug: 3-32 lowercase letters, digits and hyphens, no hyphen at either end, and never "--" in positions
// 3-4. That shape is reserved for internationalized names ("xn--…" punycode), which can display as look-alikes of
// another shop's name. The one rule for both create-tenant and the hostname parser.
const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const isValidSlug = (s) => typeof s === "string" && SLUG.test(s) && s.slice(2, 4) !== "--";

// Pure: { kind: "tenant", slug } | { kind: "reserved", slug } | { kind: "none" }. Anything that can't be a vendor
// slug is "none" here, so it never reaches the control database.
const normalizeBase = (baseDomain) => String(baseDomain || "").toLowerCase().replace(/^\.|\.$/g, "");

export function parseHost(hostname, baseDomain) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const base = normalizeBase(baseDomain);
  if (!base || !host.endsWith("." + base)) return { kind: "none" };
  const slug = host.slice(0, -(base.length + 1));
  if (RESERVED_SLUGS.has(slug)) return { kind: "reserved", slug };
  return isValidSlug(slug) ? { kind: "tenant", slug } : { kind: "none" }; // also: empty, or more than one level
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
//   platform   { db }: the admin.<BASE_DOMAIN> host; db is the control database (never a vendor's)
//   redirect   { location }: www.<BASE_DOMAIN>, sent to https://<BASE_DOMAIN>/ (301)
export async function resolveVendor(env, hostname, { registry = defaultRegistry, verified = VERIFIED } = {}) {
  const parsed = parseHost(hostname, env.BASE_DOMAIN);
  // admin.<BASE_DOMAIN>: the Venstock platform admin. Its handlers get the control database and nothing else.
  if (parsed.kind === "reserved" && parsed.slug === "admin") return { kind: "platform", db: platformDatabase(env) };
  // www.<BASE_DOMAIN>: to the public site at the apex. Decided from the hostname alone: no registry, no database.
  if (parsed.kind === "reserved" && parsed.slug === "www") return { kind: "redirect", location: `https://${normalizeBase(env.BASE_DOMAIN)}/` };
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

  // Always `binding` (derived from the numeric id), never row.db_binding. After the equality check above they are the
  // same string, so this looks redundant, and a mutation test confirms swapping them changes nothing today. It stays
  // deliberately: the database a request reaches must never be chosen by a value stored in the registry. If the check
  // above is ever loosened or reordered, this line still can't be steered by a tampered row.
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
