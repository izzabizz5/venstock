-- A Venstock staff account can be disabled (scripts/create-platform-admin.mjs --disable): it can't log in, its
-- sessions and support sessions stop working at once. Running the script again without --disable re-enables it
-- with a fresh invite. Additive only (a nullable column).

ALTER TABLE platform_admins ADD COLUMN disabled_at TEXT;
