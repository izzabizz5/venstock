-- Run ONCE to add logins (safe to re-run):
--   npx wrangler d1 execute show-pos-db --remote --file=migrations/003_auth.sql
-- Then add yourself as the first admin:  node scripts/add-admin.mjs you@example.com
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,                       -- NULL until they sign up with their invite
  invite_hash TEXT,                         -- SHA-256 of the one-time invite code
  invite_expires INTEGER,                   -- ms since 1970
  totp_secret TEXT,                         -- authenticator app secret
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0, -- last code used, so a code can't be used twice
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                      -- SHA-256 of the cookie value (the cookie itself is never stored)
  user_id INTEGER NOT NULL,
  mfa_ok INTEGER NOT NULL DEFAULT 0,        -- 0 = password checked, still needs the 6-digit code
  mfa_failures INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,              -- ms since 1970
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
