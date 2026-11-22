# CLAUDE.md

## What this is
A point-of-sale and inventory tracker for vendor shows (cash, Venmo, Zelle). It is offline-first: the PWA saves
sales on the device and uploads them when signal returns. It runs as one Cloudflare Worker (`src/`) that serves
`public/` as static assets, with D1 (SQLite). It moved off Cloudflare Pages because Pages can't serve wildcard
subdomains, which multi-tenancy needs (one subdomain per vendor).

It started as a single-vendor app called "Show POS" (that name survives only in `migrations/001-004` and in tests
that use `show-pos-db` as a database name that must be refused). **Venstock** is the multi-tenant product, where
**each vendor has its own D1 database**:
- a **control** database (binding `CONTROL`) holds the vendor registry and Venstock staff;
- each vendor's database (binding `DB_T<id>`) holds that vendor's items, shows, sales, settings, users and sessions;
- a request's hostname `<slug>.<BASE_DOMAIN>` → registry → `DB_T<id>` → that one database. Nothing else.
- `admin.<BASE_DOMAIN>` is the Venstock platform admin (staff in the control database). Staff see a vendor's data
  only through a **support session**: read-only, 30 minutes, with a reason, on the vendor's own host, audited.

**Status:** the multi-tenant build is complete on branch `multitenant-d1` (never merged to main) and has **never been
deployed**. `docs/before-first-vendor.md` is the launch checklist; `docs/runbook.md` the per-vendor operations.
Some things can only be verified on a real Cloudflare deploy; the launch checklist's drills and step 10 cover them.

**Registry cache:** the Worker caches each hostname's registry lookup in the isolate for 45 seconds
(`src/lib/control.js`), unknown vendors included. A suspension, unsuspension or new vendor takes effect within
that window, not instantly.

## Commands
`package.json` holds only the two test scripts (no dependencies); everything else runs through `npx wrangler` and `node`.

Local development (the only kind allowed by default). Vendors live at `<slug>.localhost:8788`:
```bash
node scripts/migrate.mjs --control                                  # first time only
node scripts/create-tenant.mjs demo "Demo Shop" you@example.com     # prints the owner's invite link
npx wrangler dev -c .wrangler-generated/local/wrangler.toml --persist-to .wrangler/state   # http://demo.localhost:8788
```
`--persist-to` matters: without it wrangler keeps state next to the generated config, not where the scripts put it.

Vendors and staff (local by default; each prints which databases it touches):
```bash
node scripts/create-tenant.mjs <slug> "<Vendor name>" owner@example.com   # registry row, database, migrations, owner invite
node scripts/create-tenant.mjs --resume <slug>     # finish one that stopped part-way (each step is safe to repeat)
node scripts/create-tenant.mjs --abandon <slug>    # provisioning only: mark deleted, print the database to drop BY HAND
node scripts/add-admin.mjs --tenant <slug> you@example.com    # add or reset an admin in that vendor's own database
node scripts/suspend-tenant.mjs <slug> [--resume] [--reason "<why>"]  # active <-> suspended (control only), audited
node scripts/delete-tenant.mjs <slug> --confirm <slug>        # SOFT delete of a suspended vendor; never drops a database
node scripts/create-platform-admin.mjs you@example.com        # Venstock staff: invite for http://admin.localhost:8788
node scripts/create-platform-admin.mjs --disable you@example.com   # staff leaves: no login, sessions + support sessions ended
node scripts/build-config.mjs                      # write .wrangler-generated/local/wrangler.toml from the registry
node scripts/release.mjs --local                   # release checks; the user runs the remote form, never Claude
```
`suspend-tenant` and `delete-tenant` keep their rules in `scripts/lib/tenant-status.mjs` (pure; status changes are
guarded by the expected status, the audit entry is written only if the change took effect, open support sessions on
the vendor end). `delete-tenant` refuses unless the vendor is suspended and `--confirm` repeats the exact slug; it
never drops a database or removes the registry row, so slugs are never reused. Dropping a database stays a manual
step for the user.
`release.mjs` refuses when a vendor is behind on migrations, an active vendor has no database id, the vendor count
dropped since the last release (unless `--accept-removed <slugs>`), or the tests fail. It warns about vendors stuck
in "provisioning". It only *prints* the deploy and `git tag release-…` commands: Claude never runs them.

Migrations (see `migrations/README.md`):
```bash
node scripts/migrate.mjs                      # control, then every vendor database (local)
node scripts/migrate.mjs --tenant <slug>      # one vendor
node scripts/migrations-manifest.mjs --update # record checksums of NEW migration files (commit checksums.json)
```
Scripts in `scripts/` go through `scripts/lib/d1-target.mjs`: local by default (state in `.wrangler/state`, generated
config in `.wrangler-generated/local/`); remote only with an explicit `--remote`, and then only for databases named
`venstock-dev-control` or `venstock-dev-t<id>`. They print which databases they are about to touch.
Scripts build every statement once with `stmt(sql, ...params)` (`?` placeholders; never put values into SQL text)
and hand it to `d1-target`, which checks the binding and passes it to the local executor (node:sqlite, parameters
bound) or, only for `--remote`, the remote one (`wrangler d1 execute`; parameters rendered as literals there and
only there). `tests/executor-parity.test.mjs` proves both modes send identical statements in the same order.

Tests (no dependencies; every test uses its own throwaway local databases):
```bash
node --test tests/<file>.test.mjs   # while iterating: only the file(s) for the code you changed
npm run test:fast                   # tests/**/*.unit.test.mjs: no wrangler, a few seconds
npm run test:full                   # everything (about 1 minute): before each commit and at STOP points
```
- `*.unit.test.mjs` must never start wrangler or open a database. Anything that does belongs in a plain `*.test.mjs`.
- Mutation checks (break a rule, confirm a test fails) only for isolation-critical code: the resolver, the identity
  check, the binding derivation, the lockdown, support sessions. Never weaken an assertion to make a test faster.
- Local database files are read and written directly (`scripts/lib/local-d1.mjs`, checked against real wrangler by
  `tests/local-d1.test.mjs`); starting wrangler costs about 5 s, so tests start it only for `wrangler dev` and
  `d1 migrations apply`.
- `tests/config.mjs` is the only place that says how the app is started.
- `tests/harness.mjs` seeds users with known passwords and authenticator secrets and logs in with real 6-digit codes.
- Checks that need a real browser are listed in `tests/MANUAL.md`.

Deploy: **never by Claude.** The user runs `node scripts/release.mjs` (which only prints the deploy and tag commands)
and the deploy itself, following `docs/before-first-vendor.md` and `docs/runbook.md`. `wrangler.toml`'s
`BASE_DOMAIN` is the production vendor domain (local configs always use `localhost`); every remote script refuses
until it is a real domain with a `[[routes]]` block for `*.<BASE_DOMAIN>/*`. Generated deploy configs set
`workers_dev = false` and `preview_urls = false`. The apex will serve Venstock's public site as a separate static-only Worker (`site/`, not
built yet; rules in `docs/before-first-vendor.md` section 11). Never run the original app's deploy command
(`npx wrangler pages deploy public --project-name=show-pos`) or anything against `show-pos-db`.

## Rules
- Never run any wrangler command with `--remote` in this repo, and never deploy, unless explicitly asked.
  Local development only (`--local`). This includes `--remote` on any script in `scripts/`.
- The only remote databases allowed are `venstock-dev-control` and `venstock-dev-t<id>` (enforced in
  `scripts/lib/d1-target.mjs`). Never touch any other D1 database or Pages project (in particular `show-pos-db` and
  the original `show-pos` Pages project).
- The vendor comes only from the request's hostname (via the control registry), never from the request body, URL
  path or query string. Request handlers receive only that vendor's database; they never get `env`, so they can't
  reach `CONTROL` or another vendor's binding.
  Enforced by `tests/lockdown.unit.test.mjs`: only `src/worker.js`, `src/lib/tenant.js` and `src/lib/control.js`
  mention `env`; only `tenant.js` reads `env[...]` (the derived binding); only `control.js` touches `CONTROL`;
  `handleApi` gets exactly `{ request, db, tenant, params }` (in a support session also `support`, with a read-only
  `db`); platform handlers (`src/platform.js`, admin host only) get exactly `{ request, db, params }` where `db` is the
  control database, and never `env` or a vendor binding. A new file in `src/` must be added to that test.
- Support sessions: started only at the admin host (reason required, active vendors only); the one-time link works
  once, only at that vendor's host; the `__Host-pos_support` cookie is valid only there, until it ends or 30 minutes
  pass. Anything but GET is refused (403) before a handler runs, and handlers get `readOnlyDb()`, which allows only
  single SELECT statements and never account secrets (password hashes, authenticator secrets, invites) or the
  sessions table; every support response also passes through `redactForSupport()` (`src/lib/redact.js`), and
  `tests/support-secrets.test.mjs` walks every GET route (its list must match the GET handlers in the source).
  The one-time link must be opened within 60 seconds; its code stays in the URL fragment (never sent to a server,
  never logged) and is POSTed by the page, never put in a query string. Codes and cookies are stored only hashed.
  Every step and every request goes to `audit_log` in control (append-only: triggers refuse updates and deletes);
  request bodies never do.
  A vendor's admins see every support session on their shop at `GET /api/account/support-sessions` (served by
  `src/worker.js` from control, for the hostname's vendor only; refused inside a support session).
- Every request except GET/HEAD must be `Content-Type: application/json` (415 otherwise) and, when the browser sends
  `Sec-Fetch-Site`, `same-origin` (403 otherwise): sibling subdomains are same-site, so SameSite cookies alone don't
  stop forged writes (`src/worker.js` `refuseForgedRequest`). GET requests never change anything.
- Session cookies use the `__Host-` prefix (`__Host-pos_session`, `__Host-pos_platform`, `__Host-pos_support`), with
  Secure, HttpOnly, SameSite=Strict, Path=/ and never a Domain; only the exact name is read. Staff logins last 12
  hours; staff accounts are disabled (`create-platform-admin.mjs --disable`), never deleted.
- Every response carries `Referrer-Policy: no-referrer` (and both pages have the matching meta tag).
- Vendor slugs: 3-32 of `a-z 0-9 -`, no hyphen at either end, never `--` in positions 3-4 (`xn--` look-alikes).
  `isValidSlug` in `src/lib/tenant.js` is the one rule for `create-tenant` and the hostname parser.
- Server errors answer a generic "Something went wrong" (500). Details go to the log only: method, path, vendor id
  and the error, never request bodies (customer notes, passwords) and never `e.message` in a response.
- Schema changes are new numbered files in `migrations/vendor/` or `migrations/control/`, recorded with
  `node scripts/migrations-manifest.mjs --update`. Never edit a migration that has been applied anywhere; entries
  recorded at the latest `release-*` tag can never change.
- **Migrations must be backward compatible**: between migrate and deploy, the live code runs against the new schema.
  Add first; remove or rename only in a later release.
- Any change touching data access must come with a cross-vendor test: log in as vendor A and try to read, edit or
  cancel vendor B's data (by id, and through B's hostname with A's cookie). It must fail.
- Never commit secrets, `.dev.vars`, `.env`, `.wrangler/` or `.wrangler-generated/`.
- Keep changes small: one logical change per commit.
- Test runs: while iterating, run only the test file(s) for the code you changed, or `npm run test:fast`. Run
  `npm run test:full` before every commit and at every STOP point, never after every edit. Mutation checks only for
  isolation-critical code (the resolver, the identity check, the binding derivation, the lockdown), not for routine
  steps such as the migration runner or scripts. Never weaken an assertion to make a test faster; a test that can't
  be fast belongs in `test:full` (a plain `*.test.mjs`), and say so.

## Project layout
- `wrangler.toml`: Worker name, entry point, static assets (`run_worker_first = true`), dev port 8788,
  `BASE_DOMAIN` (the production vendor domain; `localhost` until launch), the wildcard `[[routes]]` (added at launch)
  and `CONTROL`. Vendor bindings are never committed: scripts write them into `.wrangler-generated/`.
- `migrations/control/`, `migrations/vendor/`: numbered migrations with `checksums.json`. `migrations/001–004`: history
  of the original single-shop database, never run again.
- `src/worker.js`: the Worker entry point. Resolves the vendor from the hostname first: `www` = 301 to
  `https://<BASE_DOMAIN>/` (before any registry lookup), 404 unknown/other reserved/deleted,
  500 miswired (logged), 503 being set up, suspended = shell only (API 403); then `/api/*` goes to `src/api.js`
  with only that vendor's database, and everything else is a static file.
- `src/api.js`: the API handler (`handleApi`): items, shows, sales, settings, export, plus auth/users dispatch.
- `src/lib/auth.js`: invite-only sign-up, PBKDF2 passwords, TOTP 2FA, session cookie (`__Host-pos_session`),
  `/api/auth/*` and admin `/api/users/*` routes.
- `src/lib/tenant.js`: hostname → slug → registry row → `DB_T<id>` (derived from the id, must equal
  `tenants.db_binding`) → `vendor_identity` check (once per isolate). The only code that reads `env[binding]`.
- `src/lib/control.js`: the only code that reads `CONTROL` (registry lookups, cached 45 s; the vendor-host side of
  support sessions; the audit log).
- `src/platform.js`: the platform admin API at `admin.<BASE_DOMAIN>` (staff login, vendors, support sessions, audit
  log). `public/admin.html` and `public/admin.js` are its page (no offline mode).
- `src/lib/readonly-db.js`: the read-only database wrapper used in support sessions; `src/lib/redact.js`: strips
  account secrets from every support-session response.
- `src/lib/validate.js`: pure request validation (restock, sale uploads).
- `src/lib/sales.js`: records an uploaded sale: idempotent per `client_id`, priced from the vendor's own items
  (current price; the device's discount is capped at the subtotal), unknown items or show = 422, one atomic batch.
- `scripts/`: `migrate.mjs`, `migrations-manifest.mjs`, `create-tenant.mjs`, `suspend-tenant.mjs`,
  `delete-tenant.mjs`, `add-admin.mjs`, `create-platform-admin.mjs`, `build-config.mjs`, `release.mjs`; `scripts/lib/`
  holds the local/remote guard (`d1-target.mjs`), the executors (`executor.mjs`, `local-d1.mjs`), the
  generated-config writer, the checksum manifest code and the suspend/delete rules (`tenant-status.mjs`).
- `tests/`: `node --test` harness and tests; `tests/MANUAL.md` for browser-only checks.
- `docs/before-first-vendor.md`: the ordered launch checklist (decisions, Cloudflare setup, control database, drills,
  retention, first release). `docs/runbook.md`: onboarding, "being set up", support sessions, suspending, export,
  deleting, restoring, staff accounts.
- `.claude/`: Claude Code guardrails (deny rules and a hook that block remote and deploy commands).
- `public/`: the PWA front end: `index.html`, `app.js` (all screens + offline sale queue), `sync.js` (upload and
  offline rules shared with the service worker: only 400/422 mark a sale failed; the shell caches only 2xx and
  falls back to the cache on 500/502/503/504), `style.css`, `sw.js` (app-shell cache), `manifest.webmanifest`,
  `vendor/qrcode.js`. Bump `CACHE` in `sw.js` whenever a shell file changes.
- `README.md`: what Venstock is, the vendor guide, how it works, local development and tests.
