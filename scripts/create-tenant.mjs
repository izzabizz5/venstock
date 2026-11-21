// Creates a vendor: registry row, its own database, migrations, identity row and owner invite.
//
//   node scripts/create-tenant.mjs <slug> "<Vendor name>" owner@example.com    new vendor (local: the default)
//   node scripts/create-tenant.mjs --resume <slug>                             finish one that stopped part-way
//   node scripts/create-tenant.mjs --abandon <slug>                            give up on one still provisioning
//   add --remote for venstock-dev-* (you run that, never Claude)
//
// Steps (each is safe to repeat, so --resume simply runs them again from the top):
//   1. registry row in CONTROL, status "provisioning", binding DB_T<id>, database name venstock-<local|dev>-t<id>
//   2. the database: remote `wrangler d1 create`; local ones appear on first use (id local-t<id>)
//   3. migrations on that database (scripts/migrate.mjs --tenant)
//   4. vendor_identity row and the owner's invite, in the vendor's own database
//   5. status "active", generated config rewritten
// Until the next deploy binds the new database, the vendor's subdomain answers 503 "setting up" (remote).
// --abandon marks the vendor deleted and tells you which database to drop by hand. It never drops anything itself,
// and it refuses vendors that are already active.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs, d1Target, die, sqlString, EMAIL, newInvite, ROOT } from "./lib/d1-target.mjs";
import { vendorBinding, readBaseToml } from "./lib/wrangler-config.mjs";
import { RESERVED_SLUGS } from "../src/lib/tenant.js";

const USAGE = 'Usage: node scripts/create-tenant.mjs <slug> "<Vendor name>" owner@example.com [--remote]\n' +
  "       node scripts/create-tenant.mjs --resume <slug> [--remote]\n       node scripts/create-tenant.mjs --abandon <slug> [--remote]";
const { positional, flags, remote } = parseArgs(process.argv.slice(2), {
  usage: USAGE, allowed: ["--resume", "--abandon"], withValue: ["--resume", "--abandon"],
});
if (flags["--resume"] && flags["--abandon"]) die(USAGE);
const now = new Date().toISOString();
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

const t = d1Target({ remote });
if (!t.tableExists("CONTROL", "tenants")) die(`The control database isn't set up: run node scripts/migrate.mjs --control${remote ? " --remote" : ""} first.`);

const registry = () => t.query("CONTROL", "SELECT id, slug, name, status, db_binding, db_name, db_id, owner_email FROM tenants WHERE status != 'deleted' ORDER BY id");
const findRow = (slug) => t.query("CONTROL", `SELECT id, slug, name, status, db_binding, db_name, db_id, owner_email FROM tenants WHERE slug = ${sqlString(slug)}`)[0];
const dbName = (id) => `${remote ? "venstock-dev" : "venstock-local"}-t${id}`;

if (flags["--abandon"]) abandon(flags["--abandon"]);
else if (flags["--resume"]) { if (positional.length) die(USAGE); finish(flags["--resume"]); }
else create();

function create() {
  if (positional.length !== 3) die(USAGE);
  const [slug, rawName, email] = positional;
  const name = rawName.trim();
  if (!SLUG.test(slug)) die(`Bad slug "${slug}": use 3-32 lowercase letters, digits and hyphens (not at the start or end).`);
  if (RESERVED_SLUGS.has(slug)) die(`"${slug}" is reserved and can't be a vendor. Reserved: ${[...RESERVED_SLUGS].join(", ")}.`);
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) die("The vendor name must be 1-100 characters with no control characters.");
  if (!EMAIL.test(email)) die(`Bad email address "${email}".\n${USAGE}`);
  const existing = findRow(slug);
  if (existing) {
    die(existing.status === "deleted"
      ? `The slug "${slug}" belonged to an abandoned or deleted vendor and can't be reused.`
      : `A vendor with the slug "${slug}" already exists (${existing.status}).${existing.status === "provisioning" ? ` Finish it with --resume ${slug}.` : ""}`);
  }
  // 1. Registry row. The id isn't known until the insert, so the binding and database name are set right after it.
  t.run("CONTROL", `INSERT INTO tenants (slug, name, status, db_binding, db_name, owner_email, created_at, status_changed_at)
    VALUES (${sqlString(slug)}, ${sqlString(name)}, 'provisioning', 'pending', 'pending', ${sqlString(email)}, ${sqlString(now)}, ${sqlString(now)});
    UPDATE tenants SET db_binding = 'DB_T' || id, db_name = ${sqlString(`${remote ? "venstock-dev" : "venstock-local"}-t`)} || id
    WHERE slug = ${sqlString(slug)} AND db_binding = 'pending'`);
  finish(slug);
}

function finish(slug) {
  let row = findRow(slug);
  if (!row) die(`No vendor with the slug "${slug}".`);
  if (row.status === "deleted") die(`"${slug}" was abandoned or deleted; it can't be resumed.`);
  if (row.status !== "provisioning") die(`"${slug}" is already ${row.status}; nothing to resume.`);
  const step = (n, text) => console.log(`[${n}/5] ${text}`);

  step(1, `registry: ${row.slug} is tenant ${row.id}`);
  if (row.db_binding !== vendorBinding(row.id) || row.db_name !== dbName(row.id)) {
    t.run("CONTROL", `UPDATE tenants SET db_binding = ${sqlString(vendorBinding(row.id))}, db_name = ${sqlString(dbName(row.id))} WHERE id = ${row.id}`);
    row = findRow(slug);
  }

  if (!row.db_id) {
    let id;
    if (remote) {
      step(2, `creating database ${row.db_name}`);
      try { id = t.createDatabase(row.db_name); }
      catch (e) {
        die(`${e.message}\nIf ${row.db_name} already exists (an earlier run created it), look up its id with\n` +
          `  npx wrangler d1 info ${row.db_name}\nthen record it and resume:\n` +
          `  UPDATE tenants SET db_id = '<id>' WHERE id = ${row.id};   (on venstock-dev-control)\n` +
          `  node scripts/create-tenant.mjs --resume ${slug} --remote`);
      }
    } else {
      id = `local-t${row.id}`;
      step(2, `local database ${row.db_name} (id ${id}; appears on first use)`);
    }
    t.run("CONTROL", `UPDATE tenants SET db_id = ${sqlString(id)} WHERE id = ${row.id} AND db_id IS NULL`);
    row = findRow(slug);
  } else step(2, `database ${row.db_name} already recorded (${row.db_id})`);

  step(3, "migrations");
  t.writeConfig(registry());
  const m = spawnSync(process.execPath, [join(ROOT, "scripts", "migrate.mjs"), "--tenant", slug, ...(remote ? ["--remote"] : [])], {
    cwd: ROOT, encoding: "utf8", env: process.env,
  });
  if (m.status !== 0) die(`${m.stdout}${m.stderr}\nMigrations failed; ${slug} stays "provisioning". Fix the cause, then: node scripts/create-tenant.mjs --resume ${slug}${remote ? " --remote" : ""}`);

  step(4, "identity and owner");
  const binding = vendorBinding(row.id);
  t.run(binding, `INSERT OR IGNORE INTO vendor_identity (singleton, tenant_id, slug, created_at) VALUES (1, ${row.id}, ${sqlString(row.slug)}, ${sqlString(now)})`);
  const [identity] = t.query(binding, "SELECT tenant_id, slug FROM vendor_identity");
  if (!identity || identity.tenant_id !== row.id || identity.slug !== row.slug) {
    die(`STOP: ${row.db_name} says it belongs to ${JSON.stringify(identity)}, not tenant ${row.id} (${row.slug}). Nothing more was changed.`);
  }
  if (!row.owner_email) die(`No owner email recorded for ${slug}; add one with node scripts/add-admin.mjs --tenant ${slug} <email> once it is active.`);
  const [owner] = t.query(binding, `SELECT id, password_hash FROM users WHERE email = ${sqlString(row.owner_email)}`);
  let invite = null;
  if (!owner) {
    invite = newInvite();
    t.run(binding, `INSERT INTO users (email, is_admin, invite_hash, invite_expires, created_at)
      VALUES (${sqlString(row.owner_email)}, 1, ${sqlString(invite.hash)}, ${invite.expires}, ${sqlString(now)})`);
  } else if (!owner.password_hash) {
    invite = newInvite(); // resumed before the owner signed up: a fresh invite replaces the lost one
    t.run(binding, `UPDATE users SET is_admin = 1, invite_hash = ${sqlString(invite.hash)}, invite_expires = ${invite.expires} WHERE id = ${owner.id}`);
  }

  step(5, "active");
  t.run("CONTROL", `UPDATE tenants SET status = 'active', status_changed_at = ${sqlString(now)} WHERE id = ${row.id} AND status = 'provisioning'`);
  t.writeConfig(registry());

  const base = remote ? `https://${row.slug}.${readBaseToml(join(ROOT, "wrangler.toml")).vars.BASE_DOMAIN || "<BASE_DOMAIN>"}` : `http://${row.slug}.localhost:8788`;
  console.log(`\nVendor "${row.name}" (${row.slug}, tenant ${row.id}, ${binding}) is active.`);
  if (invite) {
    console.log(`Owner invite for ${row.owner_email} (valid 7 days): ${invite.pretty}`);
    console.log(`Open: ${base}/#invite=${invite.pretty}&email=${encodeURIComponent(row.owner_email)}`);
  } else console.log(`The owner ${row.owner_email} has already signed up; no new invite.`);
  if (remote) console.log("Until the next deploy binds this database, the subdomain answers 503 \"setting up\". Prepare it with: node scripts/release.mjs");
  console.log("");
}

function abandon(slug) {
  if (positional.length) die(USAGE);
  const row = findRow(slug);
  if (!row) die(`No vendor with the slug "${slug}".`);
  if (row.status === "deleted") die(`"${slug}" is already deleted.`);
  if (row.status !== "provisioning") {
    die(`Refusing: "${slug}" is ${row.status}, not provisioning. --abandon is only for vendors that never finished setting up.`);
  }
  t.run("CONTROL", `UPDATE tenants SET status = 'deleted', status_changed_at = ${sqlString(now)} WHERE id = ${row.id} AND status = 'provisioning'`);
  t.writeConfig(registry());
  console.log(`\n"${slug}" (tenant ${row.id}) is marked deleted and removed from the generated config. Its slug can't be reused.`);
  if (!row.db_id) console.log("No database was created for it, so there is nothing to drop.\n");
  else if (remote) console.log(`Its database still exists. When you're sure, drop it by hand (this can't be undone):\n  npx wrangler d1 delete ${row.db_name}\n`);
  else console.log(`Its local database (${row.db_name}, id ${row.db_id}) is still in ${t.persistTo}. Delete that folder's data by hand if you want it gone.\n`);
}
