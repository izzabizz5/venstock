# Migrations

- `control/`: the control database (vendor registry, Venstock staff).
- `vendor/`: every vendor database. Each vendor has its own database with the same schema.
- `001_*.sql`–`004_*.sql` at this level: history of the original single-shop `show-pos` database. Never run again,
  never edited.

## Rules
1. **Never edit a migration that has been applied anywhere.** Add a new numbered file (`0002_description.sql`).
2. **Backward compatible only.** Between `migrate` and `deploy`, the code that is live runs against the new schema.
   Add first (new tables, new nullable or defaulted columns, new indexes). Remove or rename only in a later release,
   once the code that stopped using the old shape is live.
3. **Record the checksum** of every new file: `node scripts/migrations-manifest.mjs --update`, and commit
   `checksums.json` with the migration. Entries recorded at the latest `release-*` tag can never change; the tests,
   `scripts/migrate.mjs` and `scripts/release.mjs` refuse to run if one does.
4. **One file is one unit.** `wrangler d1 migrations apply` rolls back a file that fails and doesn't attempt later
   files. Keep each file small enough that "all of it or none of it" is the right outcome.

## Applying
```bash
node scripts/migrate.mjs                 # control, then every vendor (local)
node scripts/migrate.mjs --tenant demo   # one vendor
```
The runner stops at the first database that fails and prints which databases are done, failed and not started.
Fix the cause and run the same command again.
