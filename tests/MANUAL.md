# Manual checks

Things the automated tests can't cover because they need a real browser. Run them when the step that
introduces them lands, and note the browser, version and date at the bottom.

Start the app locally first (see CLAUDE.md for the current command), then use the port it prints.

## Step 1: `*.localhost` is a secure context (Chrome and Firefox)
The app needs a secure context: `crypto.randomUUID()` gives each offline sale its ID, and the login cookie is
marked `Secure`.
1. Open `http://a.localhost:<port>/` (it should load the Venstock app, not a "site can't be reached" page).
2. Open the developer console and run `window.isSecureContext`. Expected: `true`.
3. Run `crypto.randomUUID()`. Expected: a UUID, not an error.
4. Repeat in the other browser.

## Step 4: each subdomain keeps its own login
Needs two vendors: `node scripts/create-tenant.mjs a "Shop A" a@example.test` and the same for `b`.
1. Log in at `http://a.localhost:<port>/` as a user of vendor A.
2. In the same browser, open `http://b.localhost:<port>/`. Expected: the login screen, not vendor A's data.
3. Developer tools → Application (Chrome) or Storage (Firefox) → Cookies: `a.localhost` has `pos_session`,
   `b.localhost` has none.
4. Log in at B as a vendor-B user, go back to A, reload. Expected: still logged in as the A user, showing A's data.

## The app survives server trouble (503) but not an unknown shop (404)
The service worker shows the cached app when the server answers 500, 502, 503 or 504, and shows 404 and 403 as
they are (tests/sync.unit.test.mjs covers the rules; this checks them in a real browser).
1. Open `http://demo.localhost:8788/`, let it load fully (developer tools → Application → Service workers: active).
2. Force a 503: stop `wrangler dev`, then start it with a config that has no `DB_T<id>` for demo (e.g. copy
   `.wrangler-generated/local/wrangler.toml`, delete demo's `[[d1_databases]]` block, and run
   `npx wrangler dev -c <that copy> --persist-to .wrangler/state`). Reload. Expected: the app still opens (from the
   cache) instead of "This shop is being set up". Network tab: the page request answered 503.
3. Close the tab, open a NEW private window at the same address. Expected: "This shop is being set up" (no cache).
4. Make the address unknown: open `http://nosuch.localhost:8788/`. Expected: "Not found", never a cached app.
5. Restart with the normal config. Reload demo. Expected: the app, and the Network tab shows 200s again.

## Offline: the app opens and rings up sales with no connection
1. Open the app, let it load fully, then go offline (developer tools → Network → Offline).
2. Close the tab, reopen the same address. Expected: the app opens and can ring up a sale ("1 to upload").
3. Go back online. Expected: within a few seconds the header shows "✓ synced" and the sale is in the Sales tab.

## A sale the server refuses goes to "failed", with a clear reason
1. Log in at `http://demo.localhost:8788/`, go offline, ring up a sale of one item. Expected: "1 to upload".
2. While offline, delete that item from the local database (a throwaway one), e.g. with
   `node --input-type=module -e` and `scripts/lib/local-d1.mjs`.
3. Go back online. Expected: a toast "1 sale couldn't be uploaded. See the Sales tab."; the header shows "1 failed"
   (tap it to open the Sales tab); the Sales tab shows a red card with the items and the reason "This sale refers
   to an item or show that isn't in this shop"; the sale is not in the totals.
4. Press "Download as CSV". Expected: `failed-sales.csv` with the sale and its reason.
5. Press "Try again". Expected: it fails again and returns to the failed list (nothing is lost).
6. Press "Remove" and confirm. Expected: the card and the header count disappear.
7. Stop the server, ring up a sale, start the server again. Expected: the sale uploads normally (a 5xx or no
   connection never marks a sale failed).

## Editing an item that no longer exists shows a clear message
1. Log in at `http://demo.localhost:8788/`, open Items, and leave the page open.
2. In a terminal, delete one item from the local vendor database (a throwaway one), e.g. with
   `node --input-type=module -e` and `scripts/lib/local-d1.mjs`, or recreate the local state.
3. Without reloading, change that item's price and press Save. Expected: an alert saying the item isn't in your
   shop any more and the change wasn't saved (not a bare "Not found"); after closing it, the item is gone from the
   list. Restocking the same stale item shows the same message.

## Results
| Check | Browser and version | Date | Result |
|---|---|---|---|
