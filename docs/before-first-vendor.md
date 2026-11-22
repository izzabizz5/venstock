# Launch checklist: before the first paying vendor

Work through this in order. Every box must be ticked, and its result noted where asked, before a paying vendor is
onboarded. **You do every step that touches Cloudflare.** Claude never runs remote commands, deploys or tags; the
repo's guardrails block it from doing so.

Commands marked "remote" talk to your Cloudflare account. The scripts in `scripts/` only ever touch D1 databases
named `venstock-dev-control` and `venstock-dev-t<id>` (enforced in `scripts/lib/d1-target.mjs`).

## 1. Decisions
- [ ] **The vendor domain (`BASE_DOMAIN`).** A registrable domain for vendor shops (`<slug>.<domain>`), the staff
  site (`admin.<domain>`) and, at the apex only, Venstock's own public site (marketing and sign-up; see 6 and 11).
  Every subdomain of it is "same-site" with every other, so nothing else may ever live on it (see 11):
  `www.<domain>` only redirects to the apex, and docs, status and support pages from other providers go on a
  different registrable domain.
- [ ] **Database names.** The scripts allow only `venstock-dev-control` and `venstock-dev-t<id>`. Either launch on
  those names, or change the rule in `scripts/lib/d1-target.mjs` (`ALLOWED_REMOTE`), its tests and CLAUDE.md
  first, as a deliberate change. Write down which: _venstock-dev-_
- [ ] **Retention for deleted vendors** (see 9): how long to keep a deleted vendor's export: _30_ days.

## 2. Cloudflare account and domain
- [ ] **Workers Paid plan** on the account. Free allows 10 D1 databases in total (one per vendor plus control) and
  50 queries per request; Paid includes 100,000 databases. About 5,000 database bindings fit in one Worker.
- [ ] **The domain is a zone in this Cloudflare account** (nameservers pointed at Cloudflare, zone active).
- [ ] **The Cloudflare login and the registrar contact use an email address that is NOT on the vendor domain**
  (not `@venstock.org`). If the domain's email ever breaks, or the domain lapses, the account that can fix it must
  still be reachable.
- [ ] **Wildcard DNS:** a proxied (orange cloud) record for `*`, e.g. `AAAA * 100::`. It needs no origin: the
  Worker answers everything, `www` included (a 301 to the apex).
- [ ] **Apex DNS:** a proxied record for the apex, e.g. `AAAA @ 100::`, for the public site's Worker (route
  `venstock.org/*`; see 6). No origin; until that Worker is deployed the apex answers nothing.
- [ ] **Email (Zoho Mail), the only other records allowed:**
  - `MX` at the apex (Zoho's mail servers, with their priorities);
  - `TXT` at the apex: SPF (`v=spf1 include:… ~all`, exactly as Zoho's setup page shows it) and Zoho's domain verification;
  - `TXT` at `<selector>._domainkey`: DKIM (the selector and key Zoho shows);
  - `TXT` at `_dmarc`: DMARC (e.g. `v=DMARC1; p=quarantine; rua=mailto:<an address you read>`).
  **Verify the domain with the TXT method, never CNAME.** A CNAME such as `zb12345678.venstock.org → zmverify.zoho.com`
  is an ordinary one-level subdomain: it would take that name away from the Worker's wildcard and hand it to a
  third-party host (see 11). If Zoho only offers a CNAME, stop and choose another way.
- [ ] **Nothing else.** No other apex or subdomain records, and none pointing at a third-party host.

## 3. The repo's production settings (you edit, then commit)
- [ ] In `wrangler.toml` `[vars]`: `BASE_DOMAIN = "<your domain>"`. (Local development is unaffected: local configs
  always use `localhost`.)
- [ ] In `wrangler.toml`, the wildcard route:
  ```toml
  [[routes]]
  pattern = "*.<your domain>/*"
  zone_name = "<your domain>"
  ```
  Every remote script refuses to run until both are set. The generated deploy config also sets
  `workers_dev = false` and `preview_urls = false`, so only this route serves the Worker.

## 4. The control database and the first staff account (remote)
- [ ] Create it: `npx wrangler d1 create venstock-dev-control`, and put the printed `database_id` into the
  `CONTROL` block of `wrangler.toml` (commit it; the id isn't a secret).
- [ ] Migrate it: `node scripts/migrate.mjs --control --remote`. Expected: every file under `migrations/control/`
  listed as applied.
- [ ] First staff account: `node scripts/create-platform-admin.mjs you@yourcompany.example --remote`. Keep the
  printed `https://admin.<domain>/#invite=…` link; it works after the first deploy (step 10) and expires in 7 days.

## 5. Protection in front of the Worker
- [ ] **Rate limiting rule** (Security → WAF → Rate limiting rules) on hostname `*.<domain>`: per client IP, a
  generous limit for normal use (e.g. 300 requests per minute), blocking for a few minutes when exceeded. A
  subdomain the Worker hasn't seen in the last 45 seconds costs one query on the shared control database, so a
  flood of made-up subdomains could slow every vendor. Add a tighter rule for `/api/auth/*` (e.g. 30 per minute
  per IP): today the only login limits are per account. Test on the dev zone: a register syncing after a long
  offline spell must stay well under the limits. Rules and numbers: ____________
- [ ] **Cloudflare Access in front of `admin.<domain>`** (Zero Trust → Access → Applications → Self-hosted, domain
  `admin.<domain>`): allow only staff emails, require your identity provider or one-time PIN. This is a second,
  independent login in front of the staff site's own password + 6-digit code.

## 6. Still to build before the first paying vendor
These don't exist yet. Each needs code, tests and review (ask Claude to build them; they're local work):
- [ ] **Owner "export everything":** one download with items, shows, upcoming shows, every sale with its lines
  (voided included), settings and the user list (emails and roles only). Today a vendor can download items and
  sales as CSV, but not settings or the user list.
- [ ] **Error visibility:** Workers Logs are on: the generated deploy config has `[observability] enabled = true`
  (written by `scripts/lib/wrangler-config.mjs`). Still to do: an alert on repeated 5xx responses. Server errors
  are logged with method, path and vendor id, never request bodies.
- [ ] **The public site at the apex:** Venstock's marketing and sign-up pages, as a SEPARATE Worker in this repo:
  `site/` with its own `wrangler.toml`, static assets only, no D1 bindings, route `venstock.org/*`, never the vendor
  Worker. Its pages load no third-party scripts or embeds, send a strict `Content-Security-Policy` (only its own
  files), and set no cookies (see 11).
  Built: `site/` (checked by `tests/site.unit.test.mjs`). Still to do, by you: fill in everything marked TODO in
  `site/public/` (the home headline in `index.html`, the Stripe payment link and contact address in `join.html`, the
  onboarding steps in `how.html`, `terms.html`, `privacy.html`), then deploy it from `site/` (`npx wrangler deploy`
  there) once the vendor Worker's wildcard route is live.
- [ ] **Stripe billing matches the pricing page** (`site/public/pricing.html` promises all of this):
  - prices: $50 setup (one-time), $9 a month or $90 a year (recurring), $25 per 30 minutes of extra help;
  - Stripe's **customer portal is turned on**, letting vendors update their card, switch between monthly and yearly,
    and cancel;
  - cancelling takes effect at the end of the paid period (not immediately), and Stripe emails receipts;
  - after a vendor cancels, they keep access to the end of the paid period, then get 30 days to export their items
    and sales before their data is deleted (`docs/runbook.md`: suspend, export, delete).

## 7. Drill: a remote migration that fails halfway keeps nothing
Locally, a failing migration file is rolled back completely (`tests/migrate.test.mjs`). Cloudflare documents the
same for `wrangler d1 migrations apply` remotely, and `scripts/migrate.mjs` relies on it. Prove it once on a
throwaway database. It uses its own folder outside the repo, so it can't touch the registry or any vendor.

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
```
- [x] **Pass:** step 5 lists `d1_migrations` and `drill_ok` but not `drill_partial`, and step 6 lists only
  `0001_ok.sql`. **Fail:** `drill_partial` exists, or `0002_fails_halfway.sql` is recorded as applied. Then stop:
  the runner's "one file is all or nothing" assumption doesn't hold remotely, and migrations would have to be
  written to be safe to re-run.
- Keep the scratch folder and database for drill 8; delete both at the end of it.

## 8. Drill: restore one vendor with Time Travel, and only that vendor
Each vendor has its own database, so a restore is per vendor: rolling back one shop never touches another. D1 keeps
30 days of history on Workers Paid. Prove the procedure once, on throwaway databases.

```bash
cd /tmp/venstock-drill
# 1. A second throwaway database ("another vendor"); add it to wrangler.toml as binding DB_T98
npx wrangler d1 create venstock-dev-t98

# 2. Rows in both; wait, then take T as a WHOLE minute (restore targets resolve to whole minutes)
npx wrangler d1 execute venstock-dev-t99 --remote --command "CREATE TABLE sales (n INTEGER); INSERT INTO sales VALUES (1), (2)"
npx wrangler d1 execute venstock-dev-t98 --remote --command "CREATE TABLE sales (n INTEGER); INSERT INTO sales VALUES (10)"
sleep 150
T=$(date -u +%Y-%m-%dT%H:%M:00Z); echo "T=$T"   # write it down

# 3. "The accident" in t99, and normal business in t98, after T; then wait
npx wrangler d1 execute venstock-dev-t99 --remote --command "DELETE FROM sales"
npx wrangler d1 execute venstock-dev-t98 --remote --command "INSERT INTO sales VALUES (11)"
sleep 120

# 4. Check what T resolves to, then restore t99 to it (it asks to confirm and prints an "undo" bookmark: keep it)
npx wrangler d1 time-travel info venstock-dev-t99 --timestamp=$T
npx wrangler d1 time-travel restore venstock-dev-t99 --timestamp=$T

# 5. Check both
npx wrangler d1 execute venstock-dev-t99 --remote --command "SELECT n FROM sales ORDER BY n"   # expect 1, 2
npx wrangler d1 execute venstock-dev-t98 --remote --command "SELECT n FROM sales ORDER BY n"   # expect 10, 11

# 6. Clean up both throwaway databases (each asks to confirm) and the folder
npx wrangler d1 delete venstock-dev-t99
npx wrangler d1 delete venstock-dev-t98
cd / && rm -rf /tmp/venstock-drill
```
- [x] **Pass:** t99 is back to 1, 2 and t98 still has 10, 11. Note how long the restore took, and keep the bookmark
  procedure in mind: a restore is itself undoable with the bookmark it prints.
- What the real drill showed:
  - **Restore targets are whole minutes.** A timestamp taken seconds after the writes can resolve to an older
    bookmark. Hence the `sleep 150` before T, the whole-minute T, and `time-travel info` before every restore.
  - **A saved bookmark is exact.** `npx wrangler d1 time-travel info <db>` with no timestamp prints the current
    bookmark; `restore --bookmark=<that>` returns to exactly that state.
  - **Every restore prints an "undo" bookmark.** Restoring to it reverses the restore; keep it until the data is
    confirmed right.
- Restoring a real vendor: `docs/runbook.md`, "Restoring a vendor's data".

## 9. Retention rules
- [ ] Written down and agreed (fill in the decision from 1):
  - A **suspended** vendor's data is kept as is; they can still open the app and export failed sales.
  - A vendor that **leaves** gets their export first (`docs/runbook.md`, "Offboarding"), then is marked deleted.
  - A **deleted** vendor's database is kept for 30 days (at least until the export has been delivered and
    confirmed), then dropped by hand. Dropping is permanent; Time Travel can't bring back a deleted database.
  - The control database's audit log is kept forever (it is append-only; nothing can change or remove a row).
  - Venstock staff accounts that leave are disabled (`create-platform-admin.mjs --disable`), never deleted, so
    the audit log keeps naming them.

## 10. The first release
- [ ] `node scripts/migrate.mjs --remote` (control and every vendor database up to date).
- [ ] `node scripts/release.mjs` (remote). It checks the migration checksums, the registry, that nothing is behind,
  the vendor count against the last release, and runs the full test suite. It writes
  `.wrangler-generated/remote/wrangler.toml` and **prints** the deploy and tag commands; it runs neither.
- [ ] Deploy with the printed command: `npx wrangler deploy -c .wrangler-generated/remote/wrangler.toml`.
- [ ] Verify:
  - `https://admin.<domain>/` asks for Cloudflare Access, then shows the staff login; the invite from step 4 works.
  - `https://made-up-name.<domain>/` and `https://status.<domain>/` answer "Not found".
  - `https://www.<domain>/anything` answers `301` with `location: https://<domain>/`.
  - Workers Logs (Workers & Pages → venstock → Logs) show the requests you just made.
  - The response headers include `referrer-policy: no-referrer`; `https://<anything>.workers.dev` doesn't serve it.
  - Onboard a test vendor end to end with `docs/runbook.md` ("Onboarding"), including a support session, then
    abandon or delete it.
- [ ] Tag the release with the printed command (`git tag release-YYYYMMDD-HHMM <commit> && git push origin <tag>`).
  The migration checksums recorded at that tag can never change afterwards; the tests and `release.mjs` enforce it.

## 11. Rules that hold after launch
- **Nothing else lives on the vendor domain.** Every subdomain is served by the vendor Worker (`www` only redirects
  to the apex). The apex serves only Venstock's own static public site (`site/`, a separate Worker): no
  third-party scripts or embeds, a strict `Content-Security-Policy`, and no cookies. Never point any subdomain, or
  the apex, at a third-party host (status pages, docs platforms, site builders, email tracking links, URL
  shorteners) or anything other people can edit.
  The only DNS records are the wildcard and apex records for the Workers, Zoho Mail's records (MX at the apex;
  SPF, verification and DMARC as TXT; DKIM as TXT at `<selector>._domainkey`; never a CNAME), and what Cloudflare
  itself needs. Check the DNS list after any change.
- **Registry changes take up to 45 seconds.** The Worker caches each subdomain's registry entry for 45 seconds per
  isolate, unknown ones included. A new vendor can show "Not found" for up to 45 seconds after setup (on top of the
  deploy it needs), and a suspension can take up to 45 seconds to apply everywhere.
- **Migrations are backward compatible**, and `migrate` runs before `deploy`.

## Results
| Step | Date | Result / notes |
|---|---|---|
| 7. Migration drill | 2026-11-22 | Passed |
| 8. Time Travel drill | 2026-11-22 | Passed (restore targets are whole minutes; see the notes under 8) |
| 10. First release | | |
