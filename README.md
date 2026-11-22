# Venstock

Point-of-sale and inventory for vendors who sell at markets, cons and pop-up shows.
Take Cash, Venmo and Zelle, track stock across several registers, and see what sold at each show.
It works offline: sales are saved on the phone and upload automatically when signal returns.

Each vendor gets their own address (`yourshop.<domain>`) and their own database. Venstock staff can't see a shop's
data except through a support session: read-only, at most 30 minutes, with a written reason, recorded in an audit
log, and listed in the shop's own Account screen.

## Using Venstock

Open your shop's address on your phone and use "Add to Home Screen" so it works like an app.

- **Sell**: pick your register (top right) once per device. Search or tap a category, then tap items to add them.
  **+ Restock** adds stock without leaving the screen. **Clear Cart** empties the order.
  Tap **Complete Sale** to open checkout: pick a discount, Cash, Venmo or Zelle, enter the cash received
  to see the change due, add customer notes, then **Confirm Sale**. **Cancel Transaction** throws the order away.
- **Sales**: every sale for the current show, with register, discount and notes. Filter by register.
  **Cancel sale** reverses a mistake after the fact (the stock goes back).
- **Items**: import from a spreadsheet (CSV), add and edit items, hide items, set bundle deals and the
  number of registers. Tap **Save** on a row after editing it.
- **Shows**: add upcoming shows ahead of time (name, date, start and end time), tap **Start** when you open
  and **End show** when you pack up. On a show day the Sell screen offers a one-tap start. Each show has
  Cash / Venmo / Zelle totals, totals per register, discounts given, best sellers and a CSV download.
- **Account**: log out, change your password, and (admins) choose who can log in and see Venstock support visits.

Items with sizes or colors: make one item per variant, e.g. "Tee - Medium".

### Importing inventory from a spreadsheet
In Google Sheets: File → Download → **Comma-separated values (.csv)**. Then Items → Choose File.
The first row with a **Name** (or **Item**) column is treated as the header. Also recognized: **Price**,
**Category** (or Type), **Stock** (or Qty / Quantity), **SKU**. You see a preview before anything is saved,
and the Items screen offers a template CSV to start from.
Re-importing is safe: items with the same SKU, or the same name + category, are updated, not duplicated.
Choose "Add the file's numbers to current stock" to import a restock sheet.

### Bundle deals
Deals apply automatically at checkout whenever an order qualifies. A deal matches items **by price**,
and it repeats if the order qualifies more than once. New shops start with no deals.

Example: **Buy 3 items priced $5.00 → $2.00 off.**
Three $5 tees cost $13 instead of $15, and six cost $26 ($4 off).

### Multiple registers
Each phone or tablet picks a register on the Sell screen. Everyone shares the same stock counts
(they refresh every 15 seconds), and each sale records which register rang it up.

### Offline sales, and sales that couldn't be uploaded
Sales rung up without signal are kept on the phone ("N to upload") and upload by themselves later. They are
recorded at the shop's current prices when they reach the server.
If the server refuses a sale for good (for example, its item was deleted in the meantime), it moves to the top of
the **Sales** tab with the reason ("N failed" in the header). From there: **Try again**, **Download as CSV** to keep
a record, or **Remove** it from the phone. Losing signal or a server hiccup never marks a sale as failed.

### Logins
Everyone logs in with email + password + a 6-digit code from an authenticator app (two-step login).
Nobody can sign up without an invite.

- **Adding people:** Account → *Who can log in* → enter their email → **Add**, then send them the link it shows.
  Invites work once and expire after 7 days.
- **Forgot password or lost phone:** an admin taps **New invite** next to their name.
- Devices stay logged in for 30 days. Sales made offline still upload after logging back in.

### Venstock support
If you ask Venstock for help, a staff member may open a support session on your shop. While it's open they can
only look, never change anything, for at most 30 minutes. Admins see every support visit (when, who, why, how
long) in the Account screen.

### Backups
Shows → Download CSV for any show, and Items → Download current items.

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
is being set up". The details, and the rules every change must follow, are in [CLAUDE.md](CLAUDE.md).

## Development

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
[docs/design.md](docs/design.md) describes the look: palette and contrast, the two typefaces (Archivo and Fraunces,
self-hosted), and the rules. The design previews are in `design/preview/`; serve the repo root to view them:
`python3 -m http.server 8000 --bind 127.0.0.1`, then `http://127.0.0.1:8000/design/preview/a.html`.

### The public site
`site/` is Venstock's own website at the bare domain (`venstock.org`): a separate Worker that serves only static
files, with a strict Content-Security-Policy. Preview it with `cd site && npx wrangler dev` (http://localhost:8790).
Text still to write is marked TODO in `site/public/`.

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
Not deployed yet. [docs/before-first-vendor.md](docs/before-first-vendor.md) is the launch checklist (domain,
Cloudflare setup, first release, drills). [docs/runbook.md](docs/runbook.md) covers the work per vendor: onboarding,
support sessions, suspending, exporting and deleting.

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
- `docs/`: the launch checklist, the runbook and the design system.
