# Venstock development (internal)

**Internal to Medein LLC.** Venstock is proprietary software (see [LICENSE](../LICENSE)); these notes are for the
people who build and operate it, not a guide to running it elsewhere. The full rules every change must follow are
in [CLAUDE.md](../CLAUDE.md).

## How it works

- **One Cloudflare Worker** (`src/`) serves the app's static files (`public/`) and its API. No build step.
- **One D1 (SQLite) database per vendor.** A **control** database holds the vendor registry, Venstock staff,
  support sessions and the audit log.
- **The vendor comes only from the hostname.** `<slug>.<domain>` → registry → that vendor's own database binding
  (`DB_T<id>`, derived from the vendor's id) → a check that the database identifies as that vendor. Request handlers
  receive only that one database; they never see the control database or any other vendor's.
- **`admin.<domain>`** is the Venstock staff site. Its code receives only the control database.
- **Offline-first app**: an installable web app with a service worker; sales are queued on the device and
  uploaded with a unique id, so a retried upload never counts twice.
- **Logins**: invite-only, PBKDF2 passwords, authenticator codes, `__Host-` cookies. Writes are accepted only as
  JSON from the same origin.

Adding a vendor creates their database and needs one deploy to connect it; until then their address says "This shop
is being set up".

## Local development

Requires Node.js 22.13 or later (`.nvmrc`). Nothing to install: `package.json` only holds the test scripts, and
wrangler runs through `npx`. Everything below is local; nothing touches Cloudflare.

### Run it locally
```bash
node scripts/migrate.mjs --control                                    # first time, and after pulling new control migrations
node scripts/create-tenant.mjs demo "Demo Shop" you@example.com       # a shop with its own database; prints an invite link
npx wrangler dev -c .wrangler-generated/local/wrangler.toml --persist-to .wrangler/state
```
Open the invite link (`http://demo.localhost:8788/#invite=…`), set a password, and scan the QR code with an
authenticator app. Plain `http://localhost:8788` answers "Not found": only a shop's own address serves the app.

- Demo data: `node scripts/seed-demo.mjs` fills `demo` with items, shows, upcoming shows and a day of sales (local
  only; `--replace` wipes demo's existing items, shows, sales and settings first).
- Locked out: `node scripts/add-admin.mjs --tenant demo you@example.com` prints a fresh invite.
- After creating another shop, restart `wrangler dev` (it connects databases when it starts).
- After pulling new migrations: `node scripts/migrate.mjs`.
- Staff site: `node scripts/create-platform-admin.mjs you@example.com`, then open the printed
  `http://admin.localhost:8788/#invite=…` link.

### Tests
```bash
npm run test:fast                   # unit tests: no wrangler, no databases, about a second
npm run test:full                   # everything, including real local servers and databases (about a minute)
node --test tests/<file>.test.mjs   # one file, while working on it
```
Every test uses its own throwaway local databases. Use `test:fast` for quick checks while editing; run `test:full`
before every commit. Checks that need a real browser are listed in `tests/MANUAL.md`. The design rules (no rounded
corners, colours only from `public/tokens.css`, WCAG AA contrast in light and dark, the public site's CSP) are tests
too, in `test:fast`.

### Design
[design.md](design.md) describes the look: palette and contrast, the two typefaces (Archivo and Fraunces,
self-hosted), and the rules. The design previews are in `design/preview/`; serve the repo root to view them:
`python3 -m http.server 8000 --bind 127.0.0.1`, then `http://127.0.0.1:8000/design/preview/a.html`.

### The public site
`site/` is Venstock's own website at the bare domain (`venstock.org`): a separate Worker that serves only static
files, with a strict Content-Security-Policy. Preview it with `cd site && npx wrangler dev` (http://localhost:8790).
Edit the HTML files in `site/public/` directly.

### Database changes
Schema changes are new numbered files in `migrations/vendor/` (every shop's database) or `migrations/control/`.
They must be backward compatible (the running code sees the new schema before the new code is deployed). Record each
new file's checksum, then apply:
```bash
node scripts/migrations-manifest.mjs --update   # commit checksums.json with the migration
node scripts/migrate.mjs                        # control, then every shop's database (local)
```
See `migrations/README.md`.

### Deploying and operating
[before-first-vendor.md](before-first-vendor.md) is the launch checklist (domain, Cloudflare setup, first release,
drills). [runbook.md](runbook.md) covers the work per vendor: onboarding, support sessions, suspending, exporting
and deleting.

### Project layout
- `src/worker.js`: the entry point: hostname → vendor (or the staff site), request checks, then the API or a file.
- `src/api.js` and `src/lib/`: the shop API (items, shows, sales, settings, users), logins, the resolver, the
  control-database code, sale recording, validation, and the read-only database used in support sessions.
- `src/platform.js`: the staff API at `admin.<domain>`.
- `public/`: the shop app (`index.html`, `app.js`, `sync.js`, `sw.js`, `tokens.css`, `style.css`, `fonts/`) and the
  staff page (`admin.html`, `admin.js`).
- `site/`: the public website at the bare domain (a separate, static-only Worker).
- `design/preview/`: design direction previews (`design/reference/` is local only and never committed).
- `scripts/`: create, suspend and delete shops, add staff, run migrations, build the deploy config, prepare a release.
- `migrations/`: `control/` and `vendor/` migrations with checksums (`001`–`004`: history of the original app).
- `tests/`: automated tests (`node --test`) and `tests/MANUAL.md`.
- `docs/`: this file, the launch checklist, the runbook and the design system.
