-- Fresh install: run this file. Existing database from before registers/discounts:
-- run the files in migrations/ in order instead.
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  show_id INTEGER,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','venmo','zelle')),
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  register TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  discount_label TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price_cents INTEGER NOT NULL
);

-- Simple key/value settings (bundle deals, number of registers). Values are JSON.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_show ON sales(show_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

-- Logins (same as migrations/003_auth.sql)
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

-- Upcoming shows (same as migrations/004_upcoming_shows.sql)
CREATE TABLE IF NOT EXISTS upcoming_shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  show_date TEXT NOT NULL,             -- YYYY-MM-DD
  start_time TEXT NOT NULL DEFAULT '', -- HH:MM (24h), optional
  end_time TEXT NOT NULL DEFAULT ''    -- HH:MM (24h), optional
);
