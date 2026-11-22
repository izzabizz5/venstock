# Venstock

Point-of-sale and inventory for vendors who sell at markets, cons and pop-up shows.
Take Cash, Venmo and Zelle, track stock across several registers, and see what sold at each show.
It works offline: sales are saved on the phone and upload automatically when signal returns.

**Venstock is a hosted service provided by Medein LLC.** Vendors sign up at [venstock.org](https://venstock.org)
and get their own shop at `yourshop.venstock.org`; there is nothing to install or run.

> **This is proprietary software, not open source.** The code in this repository is © Medein LLC, all rights
> reserved. It is not licensed for use, self-hosting, copying, modification or redistribution. See
> [LICENSE](LICENSE).

## Your shop and your data

Each shop has its own address and its own database. Venstock staff can't see a shop's data except through a
support session you ask for: read-only, at most 30 minutes, with a written reason, recorded in an audit log, and
listed in your shop's Account screen.

## Using Venstock

Open your shop's address on your phone and use "Add to Home Screen" so it works like an app.

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
- **Account**: log out, change your password, and (admins) choose who can log in and see Venstock support visits.

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
and it repeats if the order qualifies more than once. New shops start with no deals.

Example: **Buy 3 items priced $5.00 → $2.00 off.**
Three $5 tees cost $13 instead of $15, and six cost $26 ($4 off).

### Multiple registers
Each phone or tablet picks a register on the Sell screen. Everyone shares the same stock counts
(they refresh every 15 seconds), and each sale records which register rang it up.

### Offline sales, and sales that couldn't be uploaded
Sales rung up without signal are kept on the phone ("N to upload") and upload by themselves later. They are
recorded at the shop's current prices when they reach the server.
If the server refuses a sale for good (for example, its item was deleted in the meantime), it moves to the top of
the **Sales** tab with the reason ("N failed" in the header). From there: **Try again**, **Download as CSV** to keep
a record, or **Remove** it from the phone. Losing signal or a server hiccup never marks a sale as failed.

### Logins
Everyone logs in with email + password + a 6-digit code from an authenticator app (two-step login).
Nobody can sign up without an invite.

- **Adding people:** Account → *Who can log in* → enter their email → **Add**, then send them the link it shows.
  Invites work once and expire after 7 days.
- **Forgot password or lost phone:** an admin taps **New invite** next to their name.
- Devices stay logged in for 30 days. Sales made offline still upload after logging back in.

### Venstock support
If you ask Venstock for help, a staff member may open a support session on your shop. While it's open they can
only look, never change anything, for at most 30 minutes. Admins see every support visit (when, who, why, how
long) in the Account screen.

### Backups
Shows → Download CSV for any show, and Items → Download current items.

## Pricing and help

Pricing, billing and how to join are on [venstock.org](https://venstock.org/pricing). For help, contact Venstock
through the address on [venstock.org/join](https://venstock.org/join).

---

For Medein LLC staff: internal development and operations notes are in
[docs/development.md](docs/development.md), [docs/before-first-vendor.md](docs/before-first-vendor.md) and
[docs/runbook.md](docs/runbook.md).

© 2026 Medein LLC. All rights reserved. Venstock includes third-party components under their own licenses
(the Archivo and Fraunces fonts under the SIL Open Font License, in `public/fonts/`; the QR code generator under the
MIT license, in `public/vendor/qrcode.js`).
