// Accounts: invite-only sign-up, password login, and authenticator-app codes (MFA).
// Used by functions/api/[[route]].js. This file exports no onRequest, so it is not a route itself.

const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const fail = (msg, status = 400, headers) => json({ error: msg }, status, headers);

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const SESSION_DAYS = 30;          // how long a device stays logged in
const PRE_MFA_MINUTES = 15;       // time allowed between password and 6-digit code
const MAX_PASSWORD_TRIES = 5;     // then the account is locked for LOCK_MINUTES
const LOCK_MINUTES = 15;
const MAX_CODE_TRIES = 5;         // wrong 6-digit codes before the login attempt is thrown away
const INVITE_DAYS = 7;
const MIN_PASSWORD = 10;
const PBKDF2_ITERATIONS = 100000; // the most Cloudflare Workers allows

// ---------- small crypto helpers ----------
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const randomToken = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
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
const COOKIE = "pos_session";
const cookie = (token, maxAgeSeconds) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
const readToken = (request) => (request.headers.get("cookie") || "").match(/(?:^|;\s*)pos_session=([^;]+)/)?.[1];

async function startSession(db, userId, mfaOk) {
  const token = randomToken();
  const ms = mfaOk ? SESSION_DAYS * DAY : PRE_MFA_MINUTES * MINUTE;
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()),
    db.prepare("INSERT INTO sessions (id, user_id, mfa_ok, expires_at, created_at) VALUES (?,?,?,?,?)")
      .bind(await sha256(token), userId, mfaOk ? 1 : 0, Date.now() + ms, new Date().toISOString()),
  ]);
  return cookie(token, Math.floor(ms / 1000));
}

// The logged-in session for this request (joined with its user), or null.
export async function currentSession(db, request) {
  const token = readToken(request);
  if (!token) return null;
  return db
    .prepare(
      `SELECT s.id AS session_id, s.mfa_ok, s.mfa_failures, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`
    )
    .bind(await sha256(token), Date.now())
    .first();
}

// What the app needs to know about the person logged in.
const me = (u, mfaOk) => ({
  email: u.email,
  is_admin: !!u.is_admin,
  stage: mfaOk ? "ok" : u.totp_enabled ? "mfa" : "mfa_setup",
});
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ---------- /api/auth/* (the only routes open without a login) ----------
export async function authRoutes({ db, request, b, c, m, body }) {
  const sess = await currentSession(db, request);

  if (b === "me" && m === "GET") {
    if (!sess) return fail("Please log in", 401);
    return json(me(sess, sess.mfa_ok));
  }

  if (b === "login" && m === "POST") {
    const email = str(body.email);
    const user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    if (user && user.locked_until > Date.now()) {
      const mins = Math.ceil((user.locked_until - Date.now()) / MINUTE);
      return fail(`Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, 429);
    }
    const ok = await checkPassword(String(body.password ?? ""), user?.password_hash);
    if (!ok) {
      if (user) {
        const tries = user.failed_logins + 1;
        await db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?")
          .bind(tries >= MAX_PASSWORD_TRIES ? 0 : tries, tries >= MAX_PASSWORD_TRIES ? Date.now() + LOCK_MINUTES * MINUTE : 0, user.id)
          .run();
      }
      return fail("Wrong email or password.");
    }
    await db.prepare("UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?").bind(user.id).run();
    return json(me(user, false), 200, { "set-cookie": await startSession(db, user.id, false) });
  }

  if (b === "signup" && m === "POST") {
    const email = str(body.email);
    const password = String(body.password ?? "");
    const bad = "That email and invite code don't match, or the invite has expired. Ask the owner for a new invite.";
    const user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    if (user && user.locked_until > Date.now()) return fail("Too many tries. Wait 15 minutes and try again.", 429);
    const inviteOk = user && user.invite_hash && user.invite_expires > Date.now()
      && sameString(await sha256(normalizeInvite(body.invite)), user.invite_hash);
    if (!inviteOk) {
      if (user) {
        const tries = user.failed_logins + 1;
        await db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?")
          .bind(tries >= MAX_PASSWORD_TRIES ? 0 : tries, tries >= MAX_PASSWORD_TRIES ? Date.now() + LOCK_MINUTES * MINUTE : 0, user.id)
          .run();
      }
      return fail(bad);
    }
    if (password.length < MIN_PASSWORD) return fail(`Use a password of at least ${MIN_PASSWORD} characters.`);
    if (password.length > 200) return fail("That password is too long.");
    await db.batch([
      db.prepare(
        `UPDATE users SET password_hash = ?, invite_hash = NULL, invite_expires = NULL, totp_secret = NULL,
           totp_enabled = 0, totp_last_step = 0, failed_logins = 0, locked_until = 0 WHERE id = ?`
      ).bind(await hashPassword(password), user.id),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    ]);
    const fresh = { ...user, totp_enabled: 0 };
    return json(me(fresh, false), 200, { "set-cookie": await startSession(db, user.id, false) });
  }

  if (b === "logout" && m === "POST") {
    if (sess) await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sess.session_id).run();
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
      await db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").bind(secret, sess.id).run();
    }
    const label = encodeURIComponent(`Venstock:${sess.email}`);
    return json({ secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Venstock&digits=6&period=30` });
  }

  if (b === "mfa" && !c && m === "POST") {
    if (sess.mfa_ok) return json(me(sess, true));
    const step = await checkTotp(sess.totp_secret, body.code, sess.totp_last_step);
    if (!step) {
      if (sess.mfa_failures + 1 >= MAX_CODE_TRIES) {
        await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sess.session_id).run();
        return fail("Too many wrong codes. Log in again.", 401, { "set-cookie": cookie("", 0) });
      }
      await db.prepare("UPDATE sessions SET mfa_failures = mfa_failures + 1 WHERE id = ?").bind(sess.session_id).run();
      return fail("That code didn't work. Check the time on your phone and use the newest code.");
    }
    // Code is good: turn MFA on (first time) and swap the half-logged-in session for a full one.
    await db.batch([
      db.prepare("UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?").bind(step, sess.id),
      db.prepare("DELETE FROM sessions WHERE id = ?").bind(sess.session_id),
    ]);
    return json(me(sess, true), 200, { "set-cookie": await startSession(db, sess.id, true) });
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
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(next), sess.id),
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(sess.id, sess.session_id),
    ]);
    return json({ ok: true });
  }

  return fail("Not found", 404);
}

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
