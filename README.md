# Venstock

Point-of-sale and inventory for vendors who sell at markets, cons and pop-up shows.
Take Cash, Venmo and Zelle, track stock across several registers, and see what sold at each show.
It works offline: sales are saved on the phone and upload automatically when signal returns.

Venstock runs on Cloudflare Pages + Pages Functions + D1, with no build step.

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

Requires Node.js. There is no `package.json`; everything runs through `npx wrangler` and `node`.
See [CLAUDE.md](CLAUDE.md) for the project rules (local-only development, tenant isolation, migrations).

### Run it locally
```bash
npx wrangler d1 execute DB --local --file=schema.sql      # first time only: create the local tables
node scripts/add-admin.mjs you@example.com                # first time only: prints your invite link
npx wrangler pages dev public                             # then open http://localhost:8788
```
Open the invite link, set a password, and scan the QR code with an authenticator app.
Locked out locally? Run the `add-admin.mjs` command again for a fresh invite.

`scripts/add-admin.mjs` uses the local database unless you pass `--remote`. With `--remote`, it reads
`database_name` from `wrangler.toml` and refuses to run unless it is exactly `venstock-dev`. Either way it
prints which database it is about to touch.

### Database changes
`schema.sql` is the full schema for a fresh database. Changes go in a new numbered file in `migrations/`
(next number after the highest one), and `schema.sql` is updated to match. Apply one locally with:
```bash
npx wrangler d1 execute DB --local --file=migrations/NNN_name.sql
```
Never edit a migration that already exists.

### Tests
There are no automated tests yet.

### Deploying
Deployment for Venstock isn't set up yet. `wrangler.toml` has placeholder database values. The only remote
database Venstock may use is `venstock-dev`.

### Project layout
- `public/`: the app (installable web app): `index.html`, `app.js` (every screen plus the offline sale queue),
  `style.css`, `sw.js` (offline cache), `manifest.webmanifest`, `vendor/qrcode.js`.
- `functions/api/[[route]].js`: the API: items, shows, sales, settings, CSV export.
- `functions/lib/auth.js`: invites, passwords, two-step login, sessions, and the admin user list.
- `schema.sql` and `migrations/`: the database schema.
- `scripts/add-admin.mjs`: creates or resets an admin and prints an invite code (local by default).
