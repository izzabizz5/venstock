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
Needs two vendors (step 6's `create-tenant.mjs` creates them; until then this can't be run).
1. Log in at `http://a.localhost:<port>/` as a user of vendor A.
2. In the same browser, open `http://b.localhost:<port>/`. Expected: the login screen, not vendor A's data.
3. Developer tools → Application (Chrome) or Storage (Firefox) → Cookies: `a.localhost` has `pos_session`,
   `b.localhost` has none.
4. Log in at B as a vendor-B user, go back to A, reload. Expected: still logged in as the A user, showing A's data.

## Step 11: the cached app survives a 404 or 403
1. Open the app, let it load fully, then go offline (developer tools → Network → Offline).
2. Close the tab, reopen the same address. Expected: the app opens and can ring up a sale.
3. Back online, make the same address answer 404: remove that vendor from the local database, so its subdomain
   becomes unknown. Reload once (the page shows the 404), then go offline, close and reopen the tab.
   Expected: the app opens from the cache; the 404 page did not replace it.

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
