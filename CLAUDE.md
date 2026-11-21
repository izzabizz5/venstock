# CLAUDE.md

## What this is
A point-of-sale and inventory tracker for vendor shows (cash, Venmo, Zelle). It is offline-first: the PWA saves
sales on the device and uploads them when signal returns. It runs as one Cloudflare Worker (`src/`) that serves
`public/` as static assets, with D1 (SQLite). It moved off Cloudflare Pages because Pages can't serve wildcard
subdomains, which multi-tenancy needs (one subdomain per vendor).

It started as a single-vendor app called "Show POS". It is being turned into **Venstock**, a multi-tenant product
where **each vendor has its own D1 database**:
- a **control** database (binding `CONTROL`) holds the vendor registry and Venstock staff;
- each vendor's database (binding `DB_T<id>`) holds that vendor's items, shows, sales, settings, users and sessions;
- a request's hostname `<slug>.<BASE_DOMAIN>` → registry → `DB_T<id>` → that one database. Nothing else.

**In progress** (branch `multitenant-d1`): migrations, the runner and the scripts exist. The Worker still uses the
single `DB` binding until the resolver lands (steps 5–7 of the plan). Old names (`show-pos`, `show-pos-db`,
"show pos") still appear in places.

## Commands
There is no `package.json`; everything runs through `npx wrangler` and `node`.

Local development (the only kind allowed by default). Until the resolver lands, the app still uses the `DB` binding:
```bash
npx wrangler d1 execute DB --local --file=migrations/vendor/0001_baseline.sql   # fresh local DB, first time only
node scripts/add-admin.mjs you@example.com                                       # invite link for a local admin
npx wrangler dev                                                                 # http://localhost:8788
```

Migrations (see `migrations/README.md`):
```bash
node scripts/migrate.mjs                      # control, then every vendor database (local)
node scripts/migrate.mjs --tenant <slug>      # one vendor
node scripts/migrations-manifest.mjs --update # record checksums of NEW migration files (commit checksums.json)
```
Scripts in `scripts/` go through `scripts/lib/d1-target.mjs`: local by default (state in `.wrangler/state`, generated
config in `.wrangler-generated/local/`); remote only with an explicit `--remote`, and then only for databases named
`venstock-dev-control` or `venstock-dev-t<id>`. They print which databases they are about to touch.

Tests (no dependencies; each test starts its own throwaway local databases):
```bash
node --test 'tests/**/*.test.mjs'
```
- `tests/config.mjs` is the only place that says how the app is started.
- `tests/harness.mjs` seeds users with known passwords and authenticator secrets and logs in with real 6-digit codes.
- Checks that need a real browser are listed in `tests/MANUAL.md`.

Deploy: **not set up for Venstock. Don't deploy unless explicitly asked.** Never run the original app's deploy
command (`npx wrangler pages deploy public --project-name=show-pos`) or anything against `show-pos-db`.

## Rules
- Never run any wrangler command with `--remote` in this repo, and never deploy, unless explicitly asked.
  Local development only (`--local`). This includes `--remote` on any script in `scripts/`.
- The only remote databases allowed are `venstock-dev-control` and `venstock-dev-t<id>` (enforced in
  `scripts/lib/d1-target.mjs`). Never touch any other D1 database or Pages project (in particular `show-pos-db` and
  the original `show-pos` Pages project).
- The vendor comes only from the request's hostname (via the control registry), never from the request body, URL
  path or query string. Request handlers receive only that vendor's database; they never get `env`, so they can't
  reach `CONTROL` or another vendor's binding.
- Schema changes are new numbered files in `migrations/vendor/` or `migrations/control/`, recorded with
  `node scripts/migrations-manifest.mjs --update`. Never edit a migration that has been applied anywhere; entries
  recorded at the latest `release-*` tag can never change.
- **Migrations must be backward compatible**: between migrate and deploy, the live code runs against the new schema.
  Add first; remove or rename only in a later release.
- Any change touching data access must come with a cross-vendor test: log in as vendor A and try to read, edit or
  cancel vendor B's data (by id, and through B's hostname with A's cookie). It must fail.
- Never commit secrets, `.dev.vars`, `.env`, `.wrangler/` or `.wrangler-generated/`.
- Keep changes small: one logical change per commit.

## Project layout
- `wrangler.toml`: Worker name, entry point, static assets (`run_worker_first = true`), dev port 8788, the interim
  `DB` binding and `CONTROL`. Vendor bindings are never committed: scripts write them into `.wrangler-generated/`.
- `migrations/control/`, `migrations/vendor/`: numbered migrations with `checksums.json`. `migrations/001–004`: history
  of the original single-shop database, never run again.
- `src/worker.js`: the Worker entry point. `/api/*` goes to `src/api.js`; everything else is a static file.
- `src/api.js`: the API handler (`handleApi`): items, shows, sales, settings, export, plus auth/users dispatch.
- `src/lib/auth.js`: invite-only sign-up, PBKDF2 passwords, TOTP 2FA, session cookie (`pos_session`),
  `/api/auth/*` and admin `/api/users/*` routes.
- `src/lib/tenant.js`: hostname → slug (`<slug>.<BASE_DOMAIN>`, one level, reserved slugs).
- `scripts/`: `migrate.mjs`, `migrations-manifest.mjs`, `add-admin.mjs`; `scripts/lib/` holds the local/remote guard
  (`d1-target.mjs`), the generated-config writer and the checksum manifest code.
- `tests/`: `node --test` harness and tests; `tests/MANUAL.md` for browser-only checks.
- `docs/before-first-vendor.md`: what must exist before any paying vendor is onboarded (including drills you run).
- `.claude/`: Claude Code guardrails (deny rules and a hook that block remote and deploy commands).
- `public/`: the PWA front end: `index.html`, `app.js` (all screens + offline sale queue), `style.css`,
  `sw.js` (app-shell cache), `manifest.webmanifest`, `vendor/qrcode.js`.
- `README.md`: what Venstock is, the vendor guide, and local development.
