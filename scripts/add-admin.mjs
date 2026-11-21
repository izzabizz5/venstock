// Adds an admin who can log in, or resets one who is locked out (forgot password / lost phone).
// Prints a one-time invite code; open the link it prints to set a password and the authenticator app.
//
//   node scripts/add-admin.mjs you@example.com            (live site)
//   node scripts/add-admin.mjs you@example.com --local    (local dev database)
import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";

const email = process.argv[2];
const local = process.argv.includes("--local");
if (!email || !/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email)) {
  console.error("Usage: node scripts/add-admin.mjs you@example.com [--local]");
  process.exit(1);
}

// Must match newInvite() / normalizeInvite() in functions/lib/auth.js
const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code = Array.from({ length: 12 }, () => CHARS[randomInt(CHARS.length)]).join("");
const hash = createHash("sha256").update(code).digest("base64url");
const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;

const sql = `
INSERT INTO users (email, is_admin, invite_hash, invite_expires, created_at)
VALUES ('${email}', 1, '${hash}', ${expires}, '${new Date().toISOString()}')
ON CONFLICT(email) DO UPDATE SET is_admin = 1, password_hash = NULL, totp_secret = NULL, totp_enabled = 0,
  totp_last_step = 0, failed_logins = 0, locked_until = 0, invite_hash = excluded.invite_hash,
  invite_expires = excluded.invite_expires;
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = '${email}');`;

execFileSync("npx", ["wrangler", "d1", "execute", "DB", local ? "--local" : "--remote", "--command", sql], {
  stdio: ["ignore", "ignore", "inherit"],
});

const pretty = code.match(/.{4}/g).join("-");
const host = local ? "http://localhost:8788" : "https://<your site>";
console.log(`\n${email} is an admin. Invite code (valid 7 days): ${pretty}`);
console.log(`Open: ${host}/#invite=${pretty}&email=${encodeURIComponent(email)}\n`);
