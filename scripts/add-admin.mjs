// Adds an admin to one vendor, or resets one who is locked out (forgot password / lost phone). Works in that vendor's
// own database (binding DB_T<id>, found through the control registry), so it can never touch another vendor's users.
// Prints a one-time invite code; open the link it prints to set a password and the authenticator app.
//
//   node scripts/add-admin.mjs --tenant <slug> you@example.com            (local: the default)
//   node scripts/add-admin.mjs --tenant <slug> you@example.com --remote   (venstock-dev-*; you, never Claude)
import { join } from "node:path";
import { parseArgs, d1Target, die, sqlString, EMAIL, newInvite, ROOT } from "./lib/d1-target.mjs";
import { vendorBinding, readBaseToml } from "./lib/wrangler-config.mjs";

const USAGE = "Usage: node scripts/add-admin.mjs --tenant <slug> you@example.com [--remote]";
const { positional, flags, remote } = parseArgs(process.argv.slice(2), { usage: USAGE, allowed: ["--tenant"], withValue: ["--tenant"] });
const slug = flags["--tenant"];
const [email] = positional;
if (!slug || positional.length !== 1) die(USAGE);
if (!EMAIL.test(email)) die(`Bad email address "${email}".\n${USAGE}`);

const t = d1Target({ remote });
if (!t.tableExists("CONTROL", "tenants")) die(`The control database isn't set up: run node scripts/migrate.mjs --control${remote ? " --remote" : ""} first.`);
const all = t.query("CONTROL", "SELECT id, slug, name, status, db_name, db_id FROM tenants WHERE status != 'deleted' ORDER BY id");
const tenant = all.find((v) => v.slug.toLowerCase() === slug.toLowerCase());
if (!tenant) die(`No vendor with the slug "${slug}". Create one with scripts/create-tenant.mjs.`);
if (!tenant.db_id) die(`"${slug}" has no database yet; finish it with node scripts/create-tenant.mjs --resume ${tenant.slug}.`);
t.writeConfig(all);
const binding = vendorBinding(tenant.id);

const [identity] = t.query(binding, "SELECT tenant_id, slug FROM vendor_identity");
if (!identity || identity.tenant_id !== tenant.id || identity.slug !== tenant.slug) {
  die(`STOP: ${binding} (${tenant.db_name}) doesn't identify as ${tenant.slug}: ${JSON.stringify(identity ?? null)}. Nothing was changed.`);
}

const invite = newInvite();
const [user] = t.query(binding, `SELECT id FROM users WHERE email = ${sqlString(email)}`);
t.run(binding, user
  ? `UPDATE users SET is_admin = 1, password_hash = NULL, totp_secret = NULL, totp_enabled = 0, totp_last_step = 0,
       failed_logins = 0, locked_until = 0, invite_hash = ${sqlString(invite.hash)}, invite_expires = ${invite.expires}
     WHERE id = ${user.id};
     DELETE FROM sessions WHERE user_id = ${user.id};`
  : `INSERT INTO users (email, is_admin, invite_hash, invite_expires, created_at)
     VALUES (${sqlString(email)}, 1, ${sqlString(invite.hash)}, ${invite.expires}, ${sqlString(new Date().toISOString())})`);

const base = remote ? `https://${tenant.slug}.${readBaseToml(join(ROOT, "wrangler.toml")).vars.BASE_DOMAIN || "<BASE_DOMAIN>"}` : `http://${tenant.slug}.localhost:8788`;
console.log(`\n${email} is an admin of "${tenant.name}" (${tenant.slug})${user ? " (reset: password, authenticator and sessions cleared)" : ""}.`);
if (tenant.status !== "active") console.log(`Note: this vendor is ${tenant.status}; the login won't work until it is active.`);
console.log(`Invite code (valid 7 days): ${invite.pretty}`);
console.log(`Open: ${base}/#invite=${invite.pretty}&email=${encodeURIComponent(email)}\n`);
