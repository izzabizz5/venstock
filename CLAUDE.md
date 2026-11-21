# CLAUDE.md

## What this is
A point-of-sale and inventory tracker for vendor shows (cash, Venmo, Zelle). It is offline-first: the PWA saves
sales on the device and uploads them when signal returns. It runs on Cloudflare Pages (static `public/`) +
Pages Functions (`functions/`) + D1 (SQLite).

It started as a single-vendor app called "venstock". It is being turned into **Venstock**, a multi-tenant
product: many vendors share one deployment, and each vendor's data is isolated by `tenant_id`.
Multi-tenancy is **not built yet**: there are no `tenant_id` columns and no shared data-access helper.
Old names (`show-pos`, `show-pos-db`, "show pos") still appear in config, scripts and the UI.

## Commands
There is no `package.json`; everything runs through `npx wrangler` and `node`.

Local development (the only kind allowed by default):
```bash
npx wrangler d1 execute DB --local --file=schema.sql               # fresh local DB, first time only
node scripts/add-admin.mjs you@example.com                         # prints an invite link for a local admin
npx wrangler pages dev public                                      # http://localhost:8788
```
`scripts/add-admin.mjs` uses the local database by default. Remote needs an explicit `--remote`, and then the
script refuses to run unless `wrangler.toml` has `database_name = "venstock-dev"`. It prints which database
it is about to touch before it runs. Any new script in `scripts/` that talks to D1 must work the same way.

Apply a migration locally:
```bash
npx wrangler d1 execute DB --local --file=migrations/NNN_name.sql
```
`schema.sql` is the full fresh-install schema. It must stay in sync with the migrations.

Tests: **there are no tests yet** and no test runner is configured.

Deploy: **not set up for Venstock. Don't deploy unless explicitly asked.** The original app's deploy command
(`npx wrangler pages deploy public --project-name=show-pos`) and any `--remote` command against `show-pos-db`
target the original production app. Never run them.

## Rules
- Never run any wrangler command with `--remote` in this repo, and never deploy, unless explicitly asked.
  Local development only (`--local`). This includes `scripts/add-admin.mjs --remote`.
- The only remote database allowed is `venstock-dev`. Never touch any other D1 database or Pages project
  (in particular `show-pos-db` and the `show-pos` Pages project).
- Every query on vendor data must filter by `tenant_id`. The `tenant_id` must come from the logged-in session,
  never from the request body, URL or query string.
- All database access for vendor data goes through one shared helper. No raw queries in individual endpoints.
- Schema changes are new numbered files in `migrations/` (next number after the highest existing one, e.g.
  `005_...sql`). Never edit an old migration. Update `schema.sql` to match.
- Any change touching data access must come with a cross-tenant test: log in as tenant A and try to
  read/edit/cancel tenant B's data by ID. It must fail.
- Never commit secrets, `.dev.vars`, `.env` or `.wrangler/`.
- Keep changes small: one logical change per commit.

## Project layout
- `wrangler.toml`: Pages project name, build output dir (`public`), D1 binding `DB`.
- `schema.sql`: full schema for a fresh database (items, shows, sales, sale_items, settings, users,
  sessions, upcoming_shows).
- `migrations/`: numbered, run-once schema changes (`001`–`004` so far).
- `functions/api/[[route]].js`: the single catch-all API handler: `/api/items`, `/api/shows`, `/api/sales`,
  `/api/settings`, `/api/export`, plus dispatch to auth/users. Currently contains raw SQL.
- `functions/lib/auth.js`: invite-only sign-up, PBKDF2 passwords, TOTP 2FA, session cookie (`pos_session`),
  `/api/auth/*` and admin `/api/users/*` routes. Not a route itself.
- `public/`: the PWA front end: `index.html`, `app.js` (all screens + offline sale queue), `style.css`,
  `sw.js` (app-shell cache), `manifest.webmanifest`, `vendor/qrcode.js`.
- `scripts/add-admin.mjs`: creates/resets an admin and prints an invite code (local by default; `--remote`
  only works against `venstock-dev`).
- `README.md`: what Venstock is, the vendor guide, and local development.
