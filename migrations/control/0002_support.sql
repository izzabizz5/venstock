-- Support sessions: a Venstock platform admin looking at ONE vendor's data, read-only, for 30 minutes, with a
-- written reason. Every step is recorded in audit_log. Additive only (new tables).

CREATE TABLE IF NOT EXISTS support_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL REFERENCES platform_admins(id),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  reason TEXT NOT NULL,
  code_hash TEXT UNIQUE,            -- one-time code in the link the admin opens; cleared once used
  token_hash TEXT UNIQUE,           -- the vendor-host cookie (__Host-pos_support), set when the code is used
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,      -- ms since epoch; 30 minutes after the start, never extended
  entered_at TEXT,
  ended_at TEXT,
  ended_by TEXT                     -- 'admin', 'vendor-host' (the End button in the banner)
);
CREATE INDEX IF NOT EXISTS idx_support_sessions_tenant ON support_sessions(tenant_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  admin_id INTEGER,                 -- the platform admin, when there is one
  tenant_id INTEGER,                -- the vendor concerned, when there is one
  support_session_id INTEGER,
  action TEXT NOT NULL,             -- e.g. support.start, support.enter, support.request, support.denied, support.end
  detail TEXT NOT NULL DEFAULT ''   -- e.g. the reason, or "GET /api/items"; never request bodies
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
