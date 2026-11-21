// Adds an admin who can log in, or resets one who is locked out (forgot password / lost phone).
// Prints a one-time invite code; open the link it prints to set a password and the authenticator app.
//
//   node scripts/add-admin.mjs you@example.com            (local dev database: the default)
//   node scripts/add-admin.mjs you@example.com --remote   (remote: only allowed for venstock-dev)
//
// --remote reads database_name from wrangler.toml and refuses to run unless it is exactly "venstock-dev".
import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";

const ALLOWED_REMOTE_DB = "venstock-dev";
const USAGE = "Usage: node scripts/add-admin.mjs you@example.com [--remote]";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("-"));
const [email] = args.filter((a) => !a.startsWith("-"));
const unknown = flags.filter((f) => f !== "--local" && f !== "--remote");
if (unknown.length) die(`Unknown option ${unknown.join(", ")}.\n${USAGE}`);
if (flags.includes("--local") && flags.includes("--remote")) die("Pass --local or --remote, not both.");
const remote = flags.includes("--remote");
if (!email || !/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email)) die(USAGE);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// database_name of the top-level [[d1_databases]] entry with binding = "DB" in wrangler.toml.
function remoteDatabaseName() {
  const path = new URL("../wrangler.toml", import.meta.url);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    die(`Can't read ${path.pathname}.`);
  }
  const blocks = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      current = line === "[[d1_databases]]" ? {} : null;
      if (current) blocks.push(current);
      continue;
    }
    const kv = current && line.match(/^([A-Za-z_]+)\s*=\s*"([^"]*)"$/);
    if (kv) current[kv[1]] = kv[2];
  }
  const matches = blocks.filter((b) => b.binding === "DB");
  if (matches.length !== 1) die(`Refusing --remote: expected one [[d1_databases]] entry with binding "DB" in wrangler.toml, found ${matches.length}.`);
  return matches[0].database_name;
}

let target;
if (remote) {
  const name = remoteDatabaseName();
  if (name !== ALLOWED_REMOTE_DB) {
    die(`Refusing --remote: wrangler.toml has database_name = ${JSON.stringify(name ?? null)}. ` +
      `Only "${ALLOWED_REMOTE_DB}" may be used remotely.`);
  }
  target = ["d1", "execute", name, "--remote"];
  console.log(`About to touch REMOTE D1 database: ${name}`);
} else {
  target = ["d1", "execute", "DB", "--local"];
  console.log("About to touch LOCAL D1 database (binding DB, stored in .wrangler/)");
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

execFileSync("npx", ["wrangler", ...target, "--command", sql], {
  stdio: ["ignore", "ignore", "inherit"],
});

const pretty = code.match(/.{4}/g).join("-");
const host = remote ? "https://<your site>" : "http://localhost:8788";
console.log(`\n${email} is an admin. Invite code (valid 7 days): ${pretty}`);
console.log(`Open: ${host}/#invite=${pretty}&email=${encodeURIComponent(email)}\n`);
