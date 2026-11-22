// Accounts: invite-only sign-up, password login, and authenticator-app codes (MFA).
// Used by src/api.js. Not an entry point.

const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const fail = (msg, status = 400, headers) => json({ error: msg }, status, headers);

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const SESSION_DAYS = 30;          // how long a device stays logged in
const PRE_MFA_MINUTES = 15;       // time allowed between password and 6-digit code
const MAX_TRIES = 5;              // wrong passwords, codes or invite codes (together); then locked for LOCK_MINUTES
const LOCK_MINUTES = 15;
const MAX_CODE_TRIES = 5;         // wrong 6-digit codes before the login attempt is thrown away
const LOCKED = `Too many wrong tries. Wait ${LOCK_MINUTES} minutes and try again.`;
const INVITE_DAYS = 7;
const MIN_PASSWORD = 10;
const PBKDF2_ITERATIONS = 100000; // the most Cloudflare Workers allows

// ---------- small crypto helpers ----------
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
export const randomToken = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
export const sha256 = async (s) => b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function sameString(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- passwords ----------
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64u(salt)}$${b64u(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}
async function checkPassword(password, stored) {
  const [alg, iterations, salt, hash] = String(stored || "").split("$");
  if (alg !== "pbkdf2") {
    await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS); // same delay for unknown emails
    return false;
  }
  return sameString(b64u(await pbkdf2(password, fromB64u(salt), Number(iterations))), hash);
}

// ---------- authenticator codes (TOTP, RFC 6238: 6 digits, 30 seconds, SHA-1) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function newTotpSecret() {
  let bits = "", out = "";
  for (const b of crypto.getRandomValues(new Uint8Array(20))) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function base32Bytes(s) {
  let bits = "";
  for (const c of s.toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, "0"); }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
export async function totpCode(secret, step) {
  const key = await crypto.subtle.importKey("raw", base32Bytes(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new DataView(new ArrayBuffer(8));
  msg.setUint32(0, Math.floor(step / 2 ** 32));
  msg.setUint32(4, step >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg.buffer));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, "0");
}
// Returns the time step the code belongs to (allowing 30s of clock drift), or 0 if it's wrong.
// Codes at or before lastStep were already used and are refused, so a code can't be replayed.
async function checkTotp(secret, code, lastStep) {
  code = String(code ?? "").replace(/\D/g, "");
  if (code.length !== 6 || !secret) return 0;
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now - 1, now, now + 1]) {
    if (step > lastStep && sameString(await totpCode(secret, step), code)) return step;
  }
  return 0;
}

// ---------- invites ----------
// Readable codes like "K7QM-3XPA-ZR9T": no 0/O or 1/I/L to mix up.
const INVITE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const normalizeInvite = (code) => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
async function newInvite() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const code = Array.from(bytes, (b) => INVITE_CHARS[b % INVITE_CHARS.length]).join("");
  return { code: code.match(/.{4}/g).join("-"), hash: await sha256(code), expires: Date.now() + INVITE_DAYS * DAY };
}

// ---------- sessions ----------
// The __Host- prefix makes browsers accept the cookie only with Secure, Path=/ and NO Domain, from a secure origin
// (https, or localhost). So it is always host-only, and a sibling subdomain can't set or overwrite it ("cookie
// tossing"): a cookie it sets for the whole domain can't use this name. The platform admin uses its own name.
export const VENDOR_COOKIE = "__Host-pos_session";
// A Venstock support session on a vendor's host (set by src/worker.js from the admin's one-time link).
export const SUPPORT_COOKIE = "__Host-pos_support";
export const sessionCookie = (name, token, maxAgeSeconds) =>
  `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
// The value of exactly this cookie name (no prefix or suffix matches), or undefined.
export function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || undefined;
  }
  return undefined;
}

// What the app needs to know about the person logged in.
const me = (u, mfaOk) => ({
  email: u.email,
  is_admin: !!u.is_admin,
  stage: mfaOk ? "ok" : u.totp_enabled ? "mfa" : "mfa_setup",
});
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Login, 6-digit codes, invites and sessions for one "realm": a vendor's users (in that vendor's database) or the
// Venstock platform admins (in the control database). Same rules for both; separate tables and cookie names.
export const VENDOR_REALM = Object.freeze({ users: "users", sessions: "sessions", fk: "user_id", cookie: VENDOR_COOKIE, issuer: "Venstock", isAdmin: false });
export const PLATFORM_COOKIE = "__Host-pos_platform";
export const PLATFORM_REALM = Object.freeze({ users: "platform_admins", sessions: "platform_sessions", fk: "admin_id", cookie: PLATFORM_COOKIE, issuer: "Venstock admin", isAdmin: true });

export function makeAuth(R) {
  const cookie = (token, maxAgeSeconds) => sessionCookie(R.cookie, token, maxAgeSeconds);
  const readToken = (request) => readCookie(request, R.cookie);
  // Platform admins are admins by definition (their table has no is_admin column).
  const meR = (u, mfaOk) => ({ ...me(u, mfaOk), ...(R.isAdmin ? { is_admin: true } : {}) });

  async function startSession(db, userId, mfaOk) {
    const token = randomToken();
    const ms = mfaOk ? SESSION_DAYS * DAY : PRE_MFA_MINUTES * MINUTE;
    await db.batch([
      db.prepare(`DELETE FROM ${R.sessions} WHERE expires_at < ?`).bind(Date.now()),
      db.prepare(`INSERT INTO ${R.sessions} (id, ${R.fk}, mfa_ok, expires_at, created_at) VALUES (?,?,?,?,?)`)
        .bind(await sha256(token), userId, mfaOk ? 1 : 0, Date.now() + ms, new Date().toISOString()),
    ]);
    return cookie(token, Math.floor(ms / 1000));
  }

  // The logged-in session for this request (joined with its user), or null.
  async function currentSession(db, request) {
    const token = readToken(request);
    if (!token) return null;
    return db
      .prepare(
        `SELECT s.id AS session_id, s.mfa_ok, s.mfa_failures, u.*
         FROM ${R.sessions} s JOIN ${R.users} u ON u.id = s.${R.fk}
         WHERE s.id = ? AND s.expires_at > ?`
      )
      .bind(await sha256(token), Date.now())
      .first();
  }

  // ---------- wrong tries, per account ----------
  // Each attempt TAKES a try before anything is checked, in one atomic statement, so attempts sent all at once are
  // all counted. Returns { locked } (no try left: refuse without checking) or { last } (this was the last try: if it
  // fails, lock the account). A correct password gives its try back; a complete login clears the count.
  async function takeTry(db, id) {
    const r = await db.prepare(`UPDATE ${R.users} SET failed_logins = failed_logins + 1 WHERE id = ? AND locked_until <= ? RETURNING failed_logins`)
      .bind(id, Date.now()).first();
    if (!r) return { locked: true };
    if (r.failed_logins > MAX_TRIES) { await lockNow(db, id); return { locked: true }; }
    return { locked: false, last: r.failed_logins >= MAX_TRIES };
  }
  const lockNow = (db, id) => db.prepare(`UPDATE ${R.users} SET failed_logins = 0, locked_until = ? WHERE id = ?`)
    .bind(Date.now() + LOCK_MINUTES * MINUTE, id).run();
  const giveTryBack = (db, id) => db.prepare(`UPDATE ${R.users} SET failed_logins = MAX(failed_logins - 1, 0) WHERE id = ?`).bind(id).run();

  // ---------- /api/auth/* (the only routes open without a login) ----------
  async function authRoutes({ db, request, b, c, m, body }) {
    const sess = await currentSession(db, request);

    if (b === "me" && m === "GET") {
      if (!sess) return fail("Please log in", 401);
      return json(meR(sess, sess.mfa_ok));
    }

    // Wrong passwords and wrong 6-digit codes count together, per account (see takeTry), and only a complete login
    // (password AND code) clears the count, so logging in again doesn't buy more code guesses.
    // While an account is locked, only someone who has its password is told so: everyone else gets the same answer
    // as for an unknown email, after the same password check, so the lock doesn't reveal which accounts exist.
    if (b === "login" && m === "POST") {
      const email = str(body.email);
      const user = await db.prepare(`SELECT * FROM ${R.users} WHERE email = ?`).bind(email).first();
      const t = user ? await takeTry(db, user.id) : { locked: false };
      const ok = await checkPassword(String(body.password ?? ""), user?.password_hash);
      if (!ok) {
        if (t.last) await lockNow(db, user.id);
        return fail("Wrong email or password.");
      }
      if (t.locked) return fail(LOCKED, 429);
      await giveTryBack(db, user.id); // a correct password doesn't count against the account
      return json(meR(user, false), 200, { "set-cookie": await startSession(db, user.id, false) });
    }

    if (b === "signup" && m === "POST") {
      const email = str(body.email);
      const password = String(body.password ?? "");
      const bad = "That email and invite code don't match, or the invite has expired. Ask the owner for a new invite.";
      const user = await db.prepare(`SELECT * FROM ${R.users} WHERE email = ?`).bind(email).first();
      // Only an account with an invite waiting can be guessed at here, so only those count wrong tries: guessing
      // at an active account can't lock its owner out through this route.
      const invited = user && user.invite_hash && user.invite_expires > Date.now();
      const t = invited ? await takeTry(db, user.id) : { locked: false };
      const inviteOk = invited && sameString(await sha256(normalizeInvite(body.invite)), user.invite_hash);
      if (!inviteOk) {
        if (t.last) await lockNow(db, user.id);
        return fail(bad);
      }
      if (t.locked) return fail(LOCKED, 429);
      if (password.length < MIN_PASSWORD) return fail(`Use a password of at least ${MIN_PASSWORD} characters.`);
      if (password.length > 200) return fail("That password is too long.");
      await db.batch([
        db.prepare(
          `UPDATE ${R.users} SET password_hash = ?, invite_hash = NULL, invite_expires = NULL, totp_secret = NULL,
             totp_enabled = 0, totp_last_step = 0, failed_logins = 0, locked_until = 0 WHERE id = ?`
        ).bind(await hashPassword(password), user.id),
        db.prepare(`DELETE FROM ${R.sessions} WHERE ${R.fk} = ?`).bind(user.id),
      ]);
      const fresh = { ...user, totp_enabled: 0 };
      return json(meR(fresh, false), 200, { "set-cookie": await startSession(db, user.id, false) });
    }

    if (b === "logout" && m === "POST") {
      if (sess) await db.prepare(`DELETE FROM ${R.sessions} WHERE id = ?`).bind(sess.session_id).run();
      return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
    }

    // Everything below needs at least a correct password.
    if (!sess) return fail("Please log in", 401);

    // First-time MFA: hand out a secret for the authenticator app. Only before MFA is turned on,
    // so someone who only has the password can't replace an existing authenticator.
    if (b === "mfa" && c === "setup" && m === "POST") {
      if (sess.totp_enabled) return fail("Two-step login is already set up.");
      let secret = sess.totp_secret;
      if (!secret) {
        secret = newTotpSecret();
        await db.prepare(`UPDATE ${R.users} SET totp_secret = ? WHERE id = ?`).bind(secret, sess.id).run();
      }
      const label = encodeURIComponent(`${R.issuer}:${sess.email}`);
      return json({ secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(R.issuer)}&digits=6&period=30` });
    }

    if (b === "mfa" && !c && m === "POST") {
      if (sess.mfa_ok) return json(meR(sess, true));
      const endAttempt = async (msg, status) => {
        await db.prepare(`DELETE FROM ${R.sessions} WHERE id = ?`).bind(sess.session_id).run();
        return fail(msg, status, { "set-cookie": cookie("", 0) });
      };
      // Every code tried takes one of the account's tries BEFORE it is checked, so codes sent all at once can't
      // slip past the count. Locked (here or by wrong passwords elsewhere): this half-finished login ends.
      const t = await takeTry(db, sess.id);
      if (t.locked) return endAttempt(LOCKED, 429);
      const step = await checkTotp(sess.totp_secret, body.code, sess.totp_last_step);
      if (!step) {
        if (t.last) { await lockNow(db, sess.id); return endAttempt(LOCKED, 429); }
        if (sess.mfa_failures + 1 >= MAX_CODE_TRIES) return endAttempt("Too many wrong codes. Log in again.", 401);
        await db.prepare(`UPDATE ${R.sessions} SET mfa_failures = mfa_failures + 1 WHERE id = ?`).bind(sess.session_id).run();
        return fail("That code didn't work. Check the time on your phone and use the newest code.");
      }
      // Code is good: turn MFA on (first time), clear the wrong-try count, and swap the half-logged-in session for a
      // full one.
      await db.batch([
        db.prepare(`UPDATE ${R.users} SET totp_enabled = 1, totp_last_step = ?, failed_logins = 0, locked_until = 0 WHERE id = ?`).bind(step, sess.id),
        db.prepare(`DELETE FROM ${R.sessions} WHERE id = ?`).bind(sess.session_id),
      ]);
      return json(meR(sess, true), 200, { "set-cookie": await startSession(db, sess.id, true) });
    }

    // Everything below needs a full login.
    if (!sess.mfa_ok) return fail("Please log in", 401);

    if (b === "password" && m === "POST") {
      if (!(await checkPassword(String(body.current ?? ""), sess.password_hash))) return fail("Your current password is wrong.");
      const next = String(body.password ?? "");
      if (next.length < MIN_PASSWORD) return fail(`Use a password of at least ${MIN_PASSWORD} characters.`);
      if (next.length > 200) return fail("That password is too long.");
      // log out every other device
      await db.batch([
        db.prepare(`UPDATE ${R.users} SET password_hash = ? WHERE id = ?`).bind(await hashPassword(next), sess.id),
        db.prepare(`DELETE FROM ${R.sessions} WHERE ${R.fk} = ? AND id != ?`).bind(sess.id, sess.session_id),
      ]);
      return json({ ok: true });
    }

    return fail("Not found", 404);
  }

  return { currentSession, authRoutes };
}

// The vendor realm, used by src/api.js.
export const { currentSession, authRoutes } = makeAuth(VENDOR_REALM);

// ---------- /api/users/* (admins only: who is allowed to log in) ----------
export async function userRoutes({ db, b, c, m, body, sess }) {
  if (!b && m === "GET") {
    const { results } = await db
      .prepare(
        `SELECT id, email, is_admin, created_at, invite_expires,
                password_hash IS NOT NULL AS has_password, totp_enabled
         FROM users ORDER BY email`
      )
      .all();
    return json(
      results.map((u) => ({
        id: u.id,
        email: u.email,
        is_admin: !!u.is_admin,
        is_me: u.id === sess.id,
        status: u.has_password && u.totp_enabled ? "active"
          : u.has_password ? "setting up"
          : u.invite_expires > Date.now() ? "invited" : "invite expired",
      }))
    );
  }

  if (!b && m === "POST") {
    const email = str(body.email);
    if (!validEmail(email)) return fail("Enter a valid email address.");
    const exists = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (exists) return fail("That email is already on the list. Use “New invite” to send them a fresh code.");
    const inv = await newInvite();
    await db
      .prepare("INSERT INTO users (email, is_admin, invite_hash, invite_expires, created_at) VALUES (?,?,?,?,?)")
      .bind(email, body.is_admin ? 1 : 0, inv.hash, inv.expires, new Date().toISOString())
      .run();
    return json({ email, invite: inv.code });
  }

  const id = Number(b);
  const user = id ? await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first() : null;
  if (!user) return fail("Not found", 404);
  const isSelf = user.id === sess.id;

  // New invite = start over: password and authenticator are cleared and they're logged out everywhere.
  // Used when someone forgets their password or loses their phone.
  if (c === "invite" && m === "POST") {
    if (isSelf) return fail("You can't reset your own account while logged in. Ask another admin, or use the reset script.");
    const inv = await newInvite();
    await db.batch([
      db.prepare(
        `UPDATE users SET password_hash = NULL, totp_secret = NULL, totp_enabled = 0, totp_last_step = 0,
           failed_logins = 0, locked_until = 0, invite_hash = ?, invite_expires = ? WHERE id = ?`
      ).bind(inv.hash, inv.expires, user.id),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    ]);
    return json({ email: user.email, invite: inv.code });
  }

  if (!c && m === "DELETE") {
    if (isSelf) return fail("You can't remove yourself.");
    await db.batch([
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    ]);
    return json({ ok: true });
  }

  return fail("Not found", 404);
}
