// Which vendor (tenant) a request is for, from its hostname: <slug>.<BASE_DOMAIN>, exactly one level deep.
// Step 1 has only the pure hostname parsing. The registry lookup (control database), the derived DB_T<id> binding
// and the vendor_identity check are added in step 6 of the per-vendor-database plan.

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
