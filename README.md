# Venstock

Point-of-sale and inventory for vendors who sell at markets, cons and pop-up shows.
Take Cash, Venmo and Zelle, track stock across several registers, and see what sold at each show.
It works offline: sales are saved on the phone and upload automatically when signal returns.

Venstock runs as one Cloudflare Worker that also serves the app's static files, with D1 for data. No build step.

> **Status:** Venstock is being turned into a multi-tenant product, where many vendors share one deployment
> and each vendor's data is kept separate. That work is in progress. Today the app still serves **one vendor
> per database**.

## Using Venstock

Open the site on your phone and use "Add to Home Screen" so it works like an app.

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
- **Account**: log out, change your password, and (admins) choose who can log in.

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
and it repeats if the order qualifies more than once. New vendors start with no deals.

Example: **Buy 3 items priced $5.00 → $2.00 off.**
Three $5 tees cost $13 instead of $15, and six cost $26 ($4 off).

### Multiple registers
Each phone or tablet picks a register on the Sell screen. Everyone shares the same stock counts
(they refresh every 15 seconds), and each sale records which register rang it up.

### Logins
Everyone logs in with email + password + a 6-digit code from an authenticator app (two-step login).
Nobody can sign up without an invite.

- **Adding people:** Account → *Who can log in* → enter their email → **Add**, then send them the link it shows.
  Invites work once and expire after 7 days.
- **Forgot password or lost phone:** an admin taps **New invite** next to their name.
- Devices stay logged in for 30 days. Sales made offline still upload after logging back in.

### Backups
Shows → Download CSV for any show.

## Development

Requires Node.js 22.13 or later. Nothing to install: `package.json` only holds the test scripts, and wrangler runs through `npx`.
See [CLAUDE.md](CLAUDE.md) for the project rules (local-only development, tenant isolation, migrations).

### Run it locally
Each vendor has its own database and lives at its own subdomain (`<slug>.localhost` locally):
```bash
node scripts/migrate.mjs --control                                  # first time only: the vendor registry
node scripts/create-tenant.mjs demo "Demo Shop" you@example.com     # a vendor with its own database + invite link
npx wrangler dev -c .wrangler-generated/local/wrangler.toml --persist-to .wrangler/state
```
Open the invite link (`http://demo.localhost:8788/#invite=…`), set a password, and scan the QR code with an
authenticator app. Locked out? `node scripts/add-admin.mjs --tenant demo you@example.com` prints a fresh invite.

Venstock staff use `http://admin.localhost:8788` (`node scripts/create-platform-admin.mjs you@example.com` prints an
invite). From there they can open a support session to look at one shop's data: read-only, for 30 minutes, with a
written reason, and recorded in an audit log.

Every script is local unless you pass `--remote`, and then it only touches databases named `venstock-dev-control`
or `venstock-dev-t<id>`. Each prints which databases it is about to touch.

### Database changes
Each vendor will have its own database (being built; see CLAUDE.md). Schema changes are new numbered files in
`migrations/vendor/` (every vendor database) or `migrations/control/` (the vendor registry). Record each new file's
checksum, then apply:
```bash
node scripts/migrations-manifest.mjs --update   # commit checksums.json with the migration
node scripts/migrate.mjs                        # control, then every vendor database (local)
```
Never edit a migration that already exists, and keep migrations backward compatible. See `migrations/README.md`.

### Tests
```bash
npm run test:fast   # unit tests, a few seconds
npm run test:full   # everything, including real local servers and databases (a few minutes)
```
Each test file uses its own temporary local databases and removes them afterwards. Checks that need a real browser are listed in `tests/MANUAL.md`.

### Deploying
Deployment for Venstock isn't set up yet. `wrangler.toml` has placeholder database values. When it is,
`node scripts/release.mjs` checks the registry, migrations and tests, writes the deploy config and prints the deploy
and `git tag` commands for you to run.

### Project layout
- `public/`: the app (installable web app): `index.html`, `app.js` (every screen plus the offline sale queue),
  `style.css`, `sw.js` (offline cache), `manifest.webmanifest`, `vendor/qrcode.js`.
- `src/worker.js`: the entry point: sends `/api/*` to the API and serves everything else from `public/`.
- `src/api.js`: the API: items, shows, sales, settings, CSV export.
- `src/lib/auth.js`: invites, passwords, two-step login, sessions, and the admin user list.
- `src/platform.js`: the Venstock staff API at `admin.<domain>` (`public/admin.html`, `public/admin.js`).
- `tests/`: automated tests (`node --test`) and `tests/MANUAL.md` for browser checks.
- `migrations/`: the database schema as numbered migrations (`control/`, `vendor/`), applied by `scripts/migrate.mjs`.
- `scripts/`: `create-tenant.mjs` (new vendor, `--resume`, `--abandon`), `add-admin.mjs --tenant` (vendor admins),
  `create-platform-admin.mjs` (Venstock staff), `migrate.mjs`, `build-config.mjs`, `release.mjs`.
