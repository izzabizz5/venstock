# Before the first paying vendor

Venstock must not onboard a paying vendor until everything on this list exists and has been tested.
None of it is built yet. This is a checklist, not a design.

## 1. Owner-facing "export everything"
A vendor's owner can download all of their own data in one go, as CSV: items, shows, upcoming shows, every sale
with its line items (including voided sales), settings and the list of users (emails and roles, never password
hashes or authenticator secrets).
- Scoped to the logged-in vendor only, through the shared query helper, with a cross-tenant test.
- Owners (admins) only.
- Needed so a vendor can leave, keep their records, or check what we hold about them.

## 2. Delete-tenant script
A script (local by default, `venstock-dev` only when explicitly remote, like the others in `scripts/`) that
removes one vendor and everything that belongs to them: rows in every vendor table, their sessions, support
sessions and audit entries as agreed.
- Refuses to run without the tenant's slug typed twice, and prints row counts per table before deleting.
- Takes a backup of that tenant first (see 3).
- Test: delete tenant A in a database holding A and B; every A row is gone and B's row counts are unchanged.

## 3. Per-tenant backup and restore
- **Backup:** export one vendor's rows from every vendor table into a single file.
- **Restore:** put one vendor back from that file without touching any other vendor's rows, including when ids
  have moved on since the backup.
- D1's database-wide time travel is not enough on its own: rolling back the whole database to fix one vendor would
  undo every other vendor's sales.
- Test: back up A, change A and B, restore A; A matches the backup and B keeps its changes.

## 4. Per-IP login rate limiting
Today the only limits are per account: 5 wrong passwords lock that account for 15 minutes, and 5 wrong 6-digit
codes end that login attempt. Nothing slows down one address trying many accounts, or many vendors.
- Limit login, sign-up and code attempts per IP address (and per IP per vendor), across all vendors.
- Answer with 429 and a clear "try again in N minutes" message.
- Make sure a whole market sharing one Wi-Fi address isn't locked out by one person's typos.

## 5. Error monitoring
The lockdown step makes server errors return a generic message and log details server-side. Someone has to see
those logs.
- Errors (with method, path and tenant id; never request bodies, passwords or customer notes) reach a place that
  alerts a person.
- Alerts for repeated 5xx responses and for unusual numbers of rejected sales.
- A way to tie a vendor's "it didn't work" report to the logged error.

## 6. Drill: a remote migration that fails halfway keeps nothing
Locally, a failing migration file is rolled back completely (tested in `tests/migrate.test.mjs`). Cloudflare
documents the same for `wrangler d1 migrations apply` remotely ("this migration will be rolled back"), and
`scripts/migrate.mjs` relies on it. Prove it once on a throwaway remote database before the first vendor.
**You run this; Claude never runs remote commands.** It uses its own folder outside the repo, so it can't touch any
real vendor or the registry.

```bash
# 0. A scratch folder, outside the repo
mkdir -p /tmp/venstock-drill/migrations && cd /tmp/venstock-drill

# 1. Create the throwaway database; note the database_id it prints
npx wrangler d1 create venstock-dev-t99

# 2. A config for just this database (paste the id from step 1)
cat > wrangler.toml <<'EOF'
name = "venstock-drill"
compatibility_date = "2024-11-01"

[[d1_databases]]
binding = "DB_T99"
database_name = "venstock-dev-t99"
database_id = "PASTE-THE-ID-FROM-STEP-1"
migrations_dir = "migrations"
EOF

# 3. One good migration, and one that fails on its 3rd statement (a duplicate value in a UNIQUE column)
printf 'CREATE TABLE drill_ok (x INTEGER);\n' > migrations/0001_ok.sql
printf 'CREATE TABLE drill_partial (x INTEGER UNIQUE);\nINSERT INTO drill_partial VALUES (1);\nINSERT INTO drill_partial VALUES (1);\n' > migrations/0002_fails_halfway.sql

# 4. Apply: expect 0001_ok.sql to succeed and 0002_fails_halfway.sql to fail with a UNIQUE constraint error
npx wrangler d1 migrations apply venstock-dev-t99 --remote

# 5. Check: drill_ok and d1_migrations exist; drill_partial must NOT exist
npx wrangler d1 execute venstock-dev-t99 --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"

# 6. Check: only 0001_ok.sql is recorded as applied
npx wrangler d1 execute venstock-dev-t99 --remote --command "SELECT name FROM d1_migrations ORDER BY id"

# 7. Clean up: delete the throwaway database (it asks you to confirm) and the scratch folder
npx wrangler d1 delete venstock-dev-t99
cd / && rm -rf /tmp/venstock-drill
```

- **Pass:** step 5 lists `d1_migrations` and `drill_ok` but not `drill_partial`, and step 6 lists only `0001_ok.sql`.
- **Fail:** `drill_partial` exists (with or without a row), or `0002_fails_halfway.sql` is recorded as applied.
  Stop: the runner's "one file is all or nothing" assumption doesn't hold remotely, and migrations would have to be
  written to be safe to re-run before any vendor is onboarded.
- Record the result below.

| Date | wrangler version | Result |
|---|---|---|

## 7. Registry changes take up to 45 seconds to reach every request
The Worker caches each hostname's registry lookup for 45 seconds in each isolate (`src/lib/control.js`), and it
caches "no such vendor" too, so a flood of requests for made-up subdomains doesn't reach the control database.
- A **new vendor** can answer 404 for up to 45 seconds after `create-tenant` finishes (if anyone visited the
  subdomain just before), on top of the redeploy it needs for its database binding.
- A **suspension** (or unsuspension) can take up to 45 seconds to apply everywhere. Each isolate caches separately,
  so for a short while some requests may see the old status and some the new one.
- Onboarding and support scripts should say so ("live within a minute"), and anything urgent, such as cutting off
  an abusive account, has to allow for the window.

## 8. A rate-limiting rule on the wildcard route
Every request to `*.<vendor domain>` runs the Worker, and a subdomain the registry hasn't seen in the last 45
seconds costs one query on the control database, which every vendor shares. A flood of made-up subdomains could
slow lookups for all vendors (nothing can leak through it; it's an availability risk).
- Before launch, add a Cloudflare rate-limiting rule (WAF → Rate limiting rules) on the vendor domain's wildcard
  hostname: per client IP, a generous limit for normal use (e.g. a few hundred requests a minute), blocking for a
  few minutes when exceeded.
- Test it on the dev zone first: a busy register syncing after a long offline spell must stay well under the limit.
- Note the rule and its numbers here.

## 9. Nothing else lives on the vendor domain
Every `<slug>.<vendor domain>` is "same-site" with every other one, so a page on ANY subdomain of that domain
(or the apex) is trusted by browsers more than a page elsewhere. The Worker refuses cross-origin writes and the
session cookie is `__Host-` (so no sibling can overwrite it), but don't hand out that position at all:
- Never point any subdomain of the vendor domain, or the apex, at a third-party host (status pages, docs
  platforms, marketing site builders, email tracking links, URL shorteners) or anything that serves content other
  people can edit.
- Keep marketing, docs, status and support pages on a different registrable domain (e.g. `site.example` for the
  website and docs, `shops.example` for vendors).
- The only DNS records under the vendor domain are the wildcard route to the Worker and what Cloudflare itself
  needs. Check the DNS list before launch and after any change.
