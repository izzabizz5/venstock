# Runbook: the work per vendor

What you do for each vendor once Venstock is live (see `docs/before-first-vendor.md` for the launch itself).
Every command marked "remote" talks to Cloudflare: you run those, never Claude. Scripts only ever touch databases
named `venstock-dev-control` and `venstock-dev-t<id>`, and print which ones before touching them.

Useful to know throughout:
- A vendor's **slug** is their subdomain (`acme` → `https://acme.<domain>`); their **tenant id** `<id>` and database
  `venstock-dev-t<id>` are shown in the staff site's vendor list.
- Registry changes (new, suspended, deleted) take **up to 45 seconds** to reach every request.
- A new vendor database is connected to the Worker by a **deploy**; until then their address says "This shop is
  being set up".

## Onboarding a vendor
1. **Pick the slug** with them: 3-32 lowercase letters, digits and hyphens, no hyphen at either end, not starting
   with `xn--` (no `--` as the 3rd and 4th characters), and not reserved (`admin`, `www`, `api`, `app`, `support`,
   `status`, `mail`, `help`, `docs`, `login`, `static`, `assets`, `cdn`, `dev`, `staging`). A slug is never reused,
   even after the vendor is deleted.
2. **Create them** (remote):
   ```bash
   node scripts/create-tenant.mjs acme "Acme Crafts" owner@acme.example --remote
   ```
   It adds the registry row, creates `venstock-dev-t<id>`, runs the migrations, writes the database's identity
   row and the owner's invite, and marks the vendor active. It prints the owner's invite link.
   - If it stops part-way, fix the cause it prints and run `node scripts/create-tenant.mjs --resume acme --remote`
     (every step is safe to repeat).
   - To give up on one that never finished: `node scripts/create-tenant.mjs --abandon acme --remote`. It marks
     the vendor deleted and prints the database to drop by hand (`npx wrangler d1 delete venstock-dev-t<id>`).
3. **Deploy** to connect the new database:
   ```bash
   node scripts/release.mjs                 # checks, then PRINTS the deploy and tag commands
   npx wrangler deploy -c .wrangler-generated/remote/wrangler.toml
   git tag release-YYYYMMDD-HHMM <commit> && git push origin release-YYYYMMDD-HHMM   # as printed
   ```
4. **Verify:** open `https://acme.<domain>/` in a private window. Expected: the Venstock login screen (not "This
   shop is being set up", not "Not found"). If you opened it moments before the deploy, wait a minute.
5. **Invite the vendor's admin:** send the owner the invite link from step 2 (it works once and expires after 7
   days). They set a password and an authenticator app, then add their own staff from Account.
   - Lost or expired link: `node scripts/add-admin.mjs --tenant acme owner@acme.example --remote` prints a new one.
     The same command resets an admin who is locked out (new password and authenticator; their sessions end).

## When a vendor sees "This shop is being set up"
That page (HTTP 503) means one of two things. Check the vendor's status in the staff site's vendor list:
- **provisioning:** `create-tenant` didn't finish. Run `node scripts/create-tenant.mjs --resume <slug> --remote`,
  then deploy (onboarding step 3).
- **active:** the vendor's database isn't connected in the deployed Worker yet. Run `node scripts/release.mjs` and
  deploy (onboarding step 3). If you deployed less than a minute ago, wait a minute first.
Their devices keep any offline sales queued meanwhile; a 503 never marks a sale as failed.

## Troubleshooting with a support session
A support session lets one staff member **look at** one vendor's data: read-only, for at most 30 minutes, with a
written reason. Every step and every page viewed is in the audit log, and the vendor's admins see the visit (when,
who, why, how long) in their Account screen. Ask the vendor before opening one.
1. At `https://admin.<domain>/` (Cloudflare Access, then your staff login), press **Support session** next to the
   vendor and type the reason (it's shown to the vendor).
2. Press **Open support session** within 60 seconds: the link works once, only on that vendor's site.
3. A new tab opens their site with an orange "Venstock support session: read-only" banner. You see what their admin
   sees; every change (selling, editing, adding users) is refused.
4. Press **End now** in the banner when done (or end it from the staff site). It also ends by itself after 30
   minutes.
- Anything that needs a change: ask the vendor's admin to make it, or use the scripts (e.g. `add-admin.mjs` for a
  locked-out admin).
- The audit log in the staff site shows the session's start, reason, each page viewed, refused changes and the end.

## Suspending a vendor (and lifting it)
A suspended vendor's site still opens (so they can see the message and export failed sales), but every API request
answers "This account is suspended. Contact Venstock support." (remote):
```bash
node scripts/suspend-tenant.mjs acme --reason "Unpaid invoice" --remote
node scripts/suspend-tenant.mjs acme --resume --remote          # lift it
```
- Only the control database changes; the vendor's data is untouched. Each change is recorded in the audit log
  (`vendor.suspended` / `vendor.unsuspended`, with the reason if given).
- Suspending also ends any open support session on the vendor, and new ones can't be opened while suspended.
- Both take effect within 45 seconds; no deploy is needed.
- It refuses an unknown slug, a vendor that is already in the asked-for state, one still provisioning (use
  `create-tenant.mjs --resume` or `--abandon`), and a deleted one.

## Offboarding and data export
1. **The vendor's own downloads, while they are still active** (a suspended vendor's API is closed, so these stop
   working once suspended; they do them themselves, as admins): Items → Download current items (CSV); Shows →
   Download CSV per show; the full sales CSV (all shows); and any failed sales still on a device (Sales tab →
   Download as CSV).
2. **Suspend them**, so nothing changes from here on (remote):
   `node scripts/suspend-tenant.mjs acme --reason "Leaving" --remote`.
3. **A complete copy** (until the owner "export everything" download exists, see the launch checklist): export
   their database (remote):
   ```bash
   npx wrangler d1 export venstock-dev-t<id> --remote --output=acme-YYYY-MM-DD.sql
   ```
   This file holds everything, including password hashes, authenticator secrets and sessions: treat it as secret.
   Before handing it to the vendor, remove the `users` and `sessions` rows (or send only the CSVs from step 1 plus
   the user list as emails and roles).
4. Keep the export for the retention period agreed in the launch checklist, then delete it.

## Deleting a vendor
Only after offboarding (above), and after the export has been delivered and confirmed.
1. **Mark them deleted** in the registry (remote). The vendor must already be suspended, and `--confirm` must repeat
   the exact slug:
   ```bash
   node scripts/delete-tenant.mjs acme --confirm acme --reason "Closed the shop" --remote
   ```
   This is a soft delete: status `deleted`, any open support session ended, a `vendor.deleted` audit entry, and the
   binding left out of the generated config. Their address answers "Not found" within 45 seconds. It never drops
   the database and never removes the registry row, so the slug can never be used again (`create-tenant` refuses
   it). It prints the remaining steps below, with the exact database name.
2. **Disconnect the database** with the next release. `release.mjs` refuses a release with fewer vendors than the
   last one unless you name exactly who is gone:
   ```bash
   node scripts/release.mjs --accept-removed acme
   npx wrangler deploy -c .wrangler-generated/remote/wrangler.toml
   ```
3. **Drop the database by hand** after the retention period: `npx wrangler d1 delete venstock-dev-t<id>`. This is
   permanent; Time Travel can't bring back a deleted database. The registry row and the audit log stay.

## Restoring a vendor's data
Each vendor's database can be rolled back on its own (Time Travel keeps 30 days), without touching any other vendor.
Follow the procedure proven in the launch checklist (drill 8) on `venstock-dev-t<id>`, after agreeing the point in
time with the vendor. Sales uploaded after that time are lost from the server; devices still holding queued sales
upload them again.

## Venstock staff accounts
- New staff: `node scripts/create-platform-admin.mjs person@yourcompany.example --remote` (and add them to the
  Cloudflare Access policy for `admin.<domain>`). Staff logins last 12 hours.
- Someone leaves, or a laptop is lost: `node scripts/create-platform-admin.mjs --disable person@yourcompany.example
  --remote`. Their login, sessions and any open support sessions stop at once, and the audit log records it. Remove
  them from the Access policy too. Running the script again without `--disable` re-enables them with a new invite.
