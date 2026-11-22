# Manual checks

Things the automated tests can't cover because they need a real browser. Run them when the step that
introduces them lands, and note the browser, version and date at the bottom.

## Setup (once)
The app only answers on a vendor's own subdomain (`<slug>.localhost:8788`); plain `localhost:8788` says "Not found".
From the repo folder, with Node 22.13 or later:
```bash
node scripts/migrate.mjs --control                                   # the vendor registry
node scripts/create-tenant.mjs demo "Demo Shop" you@example.com      # prints an invite link: keep it
npx wrangler dev -c .wrangler-generated/local/wrangler.toml --persist-to .wrangler/state   # leave running
```
Open the invite link (`http://demo.localhost:8788/#invite=…`), set a password and scan the QR code with an
authenticator app. Locked out: `node scripts/add-admin.mjs --tenant demo you@example.com` prints a new invite.
After creating another vendor, stop `wrangler dev` (Ctrl+C) and start it again: it only picks up new vendor
databases when it starts.

## Step 1: `*.localhost` is a secure context (Chrome and Firefox)
The app needs a secure context: `crypto.randomUUID()` gives each offline sale its ID, and the login cookie is
marked `Secure`.
1. Open `http://demo.localhost:8788/` (it should load the Venstock app, not a "site can't be reached" page).
2. Open the developer console and run `window.isSecureContext`. Expected: `true`.
3. Run `crypto.randomUUID()`. Expected: a UUID, not an error.
4. Repeat in the other browser.

## Step 4: each subdomain keeps its own login
Needs a second vendor (vendor names are 3-32 characters): `node scripts/create-tenant.mjs acme "Acme Crafts"
you+acme@example.com`, then restart `wrangler dev`. Vendor A is `demo`, vendor B is `acme`.
1. Log in at `http://demo.localhost:8788/` as a user of vendor A.
2. In the same browser, open `http://acme.localhost:8788/`. Expected: the login screen, not vendor A's data.
3. Developer tools → Application (Chrome) or Storage (Firefox) → Cookies: `demo.localhost` has `__Host-pos_session`,
   `acme.localhost` has none.
4. Log in at B as a vendor-B user, go back to A, reload. Expected: still logged in as the A user, showing A's data.

## The `__Host-` session cookie is accepted on `http://*.localhost` (Chrome and Firefox)
The login cookie is `__Host-pos_session`: browsers only accept it with Secure, Path=/ and no Domain, from a secure
origin. Local dev is plain http, which browsers treat as secure only for localhost names, so check it works there.
1. Log out if logged in, then log in at `http://demo.localhost:8788/` (password and 6-digit code).
2. Expected: you stay logged in after a reload. Developer tools → Cookies for `demo.localhost`: one cookie,
   `__Host-pos_session`, with Secure, HttpOnly, SameSite Strict, Path `/`, and no Domain (host-only).
3. An old `pos_session` cookie from before the rename may still be listed; it's ignored. Delete it to tidy up.
4. Repeat in the other browser. If either browser refuses the cookie (login succeeds but every reload shows the
   login screen again), note it here: local dev would then need the unprefixed name.

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

## The platform admin page and a support session (Chrome and Firefox)
1. `node scripts/create-platform-admin.mjs you+staff@example.com` and open the printed link
   (`http://admin.localhost:8788/#invite=…`). Set a password, scan the QR code, enter the 6-digit code. Expected:
   the Vendors list with `demo` (and `acme` if created). Cookies for `admin.localhost`: `__Host-pos_platform`, no
   Domain.
2. Press "Support session" next to `demo`, type a reason. Expected: a "Support link for demo" card with a countdown
   ("58 s left", going down each second). Right-click "Open support session" and copy the link (for step 6), then
   press it. Expected: a new tab at `http://demo.localhost:8788/` with an orange banner "Venstock support
   session: read-only, ends at …", showing demo's items and sales; the admin card now says the link was opened and
   works only once (no button).
   Also: start another session for `demo` and wait out the countdown. Expected: at 0 the button is replaced by "Link
   expired: … Start a new support session."; the session still shows in the list (it expires on its own).
3. In that tab, try to ring up a sale and to edit an item. Expected: "read-only support session" messages; nothing
   changes (check in a normal demo login).
4. Reload the admin page. Expected: the session listed as active; the audit log shows support.start, support.enter
   and support.request lines.
5. Press "End now" in the banner. Expected: the login screen. The admin page shows the session as "ended
   (vendor-host)".
6. Paste the link copied in step 2 into a new tab. Expected: an alert that the link is invalid, already used or expired.
7. In a normal tab, log in at `http://demo.localhost:8788/` as demo's owner. Expected: no banner, everything normal.

## Look and feel (docs/design.md), on a phone in sunlight if possible
Fill demo first: `node scripts/seed-demo.mjs --replace` (local only; wipes demo's items, shows, sales and settings).
1. Logged out: a deep-blue field with the stacked wordmark beside (desktop) or above (phone) the form. The header
   shows only the Dark/Light button.
2. Sell screen, desktop: sky header band, cream item tiles with sage gaps, deep-blue order panel. Tap items: each
   fills sky blue with a count in its corner. The total is bold, a little bigger than the subtotal; Complete sale is
   orange. On an iPad (768 and 1032 wide) the header fits on one line and the show name isn't cut off; on a phone
   every category is visible (they wrap onto a second row).
3. Phone (or a 390px window): the tabs sit along the bottom; a deep-blue bar above them shows the item count and
   total. Tap it: the order slides up; the × closes it. Every button is easy to hit with a thumb.
4. Checkout: payment is three joined buttons (the chosen one dark); Exact / $20 / $50 fill the cash box; Change due
   is large. Confirm sale is orange with a dark edge.
   Items list: every other row has a slightly darker background.
5. Press Dark: the whole app turns dark navy, text stays readable, the button now says Light; reload keeps it.
   The browser's address bar colour follows (Android Chrome).
6. With "reduce motion" on in the OS, the order sheet and toast appear without sliding.
7. Nothing anywhere has rounded corners or soft shadows; no emoji appear as icons.
8. Offline (developer tools → Network → Offline), reload: the fonts and colours are the same as online (they are
   in the app-shell cache).
9. Sales with a failed sale (see "A sale the server refuses…" above): a brick-red block says what happened, each
   failed sale has a brick edge and its reason in words; the header shows "1 failed" in a dark block.
10. In a support session (see the platform admin section): a mustard banner with "End now" across the top; scroll
    the Sell screen on a laptop: the banner and the header both stay, the header below the banner, nothing hidden.
11. The staff admin page (`admin.localhost`) has a dark ink header, never the sky one, so it can't be mistaken for a
    shop. A new support link shows a mustard card with a large countdown and an orange Open button.

## Results
| Check | Browser and version | Date | Result |
|---|---|---|---|
