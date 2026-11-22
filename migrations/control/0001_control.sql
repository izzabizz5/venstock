-- Control database baseline: the vendor registry and Venstock's own staff. Applied by scripts/migrate.mjs
-- (wrangler d1 migrations apply). Never edit an applied file; add a new one.

-- One row per vendor. The Worker resolves <slug>.<BASE_DOMAIN> here, then uses the binding DB_T<id>.
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,    -- the subdomain
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'suspended', 'deleted')),
  db_binding TEXT NOT NULL,                    -- always 'DB_T' || id; the Worker checks this
  db_name TEXT NOT NULL,                       -- e.g. venstock-dev-t12 (remote) or venstock-local-t12
  db_id TEXT,                                  -- Cloudflare database_id; NULL until the database exists
  schema_version TEXT,                         -- last vendor migration applied (scripts/migrate.mjs)
  owner_email TEXT,                            -- for create-tenant --resume
  created_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL
);

-- Venstock staff. Never rows in any vendor's users table. They will log in only at admin.<BASE_DOMAIN>.
CREATE TABLE IF NOT EXISTS platform_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  invite_hash TEXT,
  invite_expires INTEGER,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES platform_admins(id),
  mfa_ok INTEGER NOT NULL DEFAULT 0,
  mfa_failures INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_sessions_admin ON platform_sessions(admin_id);
