// Creates (or resets) a Venstock platform admin: Venstock staff, stored in the control database, never a user of
// any vendor. Prints a one-time invite code for admin.<BASE_DOMAIN>.
//
//   node scripts/create-platform-admin.mjs you@example.com            (local: the default)
//   node scripts/create-platform-admin.mjs you@example.com --remote   (venstock-dev-control; you, never Claude)
//
// Open the printed link at admin.<BASE_DOMAIN> (locally http://admin.localhost:8788) to set a password and the
// authenticator app.
import { parseArgs, d1Target, die, stmt, EMAIL, newInvite } from "./lib/d1-target.mjs";

const USAGE = "Usage: node scripts/create-platform-admin.mjs you@example.com [--remote]";
const { positional, remote } = parseArgs(process.argv.slice(2), { usage: USAGE });
if (positional.length !== 1) die(USAGE);
const [email] = positional;
if (!EMAIL.test(email)) die(`Bad email address "${email}".\n${USAGE}`);

const t = d1Target({ remote });
if (!t.tableExists("CONTROL", "platform_admins")) die(`The control database isn't set up: run node scripts/migrate.mjs --control${remote ? " --remote" : ""} first.`);
const invite = newInvite();
const [existing] = t.query("CONTROL", stmt("SELECT id FROM platform_admins WHERE email = ?", email));
if (existing) {
  t.run("CONTROL",
    stmt(`UPDATE platform_admins SET password_hash = NULL, totp_secret = NULL, totp_enabled = 0, totp_last_step = 0,
      failed_logins = 0, locked_until = 0, invite_hash = ?, invite_expires = ? WHERE id = ?`, invite.hash, invite.expires, existing.id),
    stmt("DELETE FROM platform_sessions WHERE admin_id = ?", existing.id));
} else {
  t.run("CONTROL", stmt("INSERT INTO platform_admins (email, invite_hash, invite_expires, created_at) VALUES (?, ?, ?, ?)",
    email, invite.hash, invite.expires, new Date().toISOString()));
}

console.log(`\n${email} is a Venstock platform admin${existing ? " (reset: password, authenticator and sessions cleared)" : ""}.`);
console.log(`Invite code (valid 7 days): ${invite.pretty}`);
console.log(`Open: ${remote ? "https://admin.<BASE_DOMAIN>" : "http://admin.localhost:8788"}/#invite=${invite.pretty}&email=${encodeURIComponent(email)}\n`);
