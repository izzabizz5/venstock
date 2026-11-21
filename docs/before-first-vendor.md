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
