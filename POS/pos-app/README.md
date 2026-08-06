# Restaurant POS — Excel-backed

A point-of-sale system for a small restaurant. Multiple tills on the shop wifi,
one server, and a plain `.xlsx` workbook you can open in Excel at any time.

---

## The one rule that keeps your data safe

**Only the server writes `data/pos-data.xlsx`. Never edit it while the server is
running.**

Everything else in this document follows from that. Tills are browsers — they
talk to the server, not to the file. That is what makes it safe to run six tills
against a spreadsheet, and it is the only thing that makes it safe.

You can *open* the workbook to look at it while service is running. The server
will notice it is locked, keep recording every sale to its journal, and write
them into the file as soon as you close it. You'll see "Workbook locked — sales
still saving" at the bottom of every till while that's true. Nothing is lost.

---

## Setup (once)

Install **Node.js LTS** from [nodejs.org](https://nodejs.org) on the machine that
will act as the server — usually the billing counter PC. Run the installer and
click through the defaults.

Then double-click **`1-SETUP.bat`**.

It installs the components, generates a signing secret, and creates the workbook
and your first two accounts. It prints a **Manager PIN** and a **Cashier PIN**
once — write them down before closing the window. Change them from the Staff tab
after you sign in.

Safe to run again if something fails partway; it won't overwrite a secret or
overwrite existing accounts.

---

## Running it

Double-click **`2-START-POS.bat`**. Leave that window open while the restaurant
is trading — closing it stops every till.

It prints the addresses to use. On the server machine itself:
`https://localhost:4000`. On other tills, use the **lan** address it prints,
which looks like `https://192.168.1.15:4000`.

**The first time each device visits, its browser will show a warning** —
"Your connection is not private" or similar. This is expected, not a problem:
the server signs its own certificate rather than buying one from a public
authority, because there's no public domain name for a shop LAN to prove
ownership of. Tap **Advanced**, then **Proceed to `<address>` (unsafe)** — on
iPhone, tap **Show Details**, then **visit this website**. Do this once per
device; the browser remembers after that and the warning won't come back.

Open that address in Chrome/Safari on each till, accept the warning, sign in
with a name and PIN, and start billing. On a tablet, use "Add to Home Screen"
so it opens full-screen.

Press `Ctrl+C` in the server window to stop at end of day.

<details>
<summary>Want the warning gone entirely instead of clicking through it?</summary>

Each device can install the certificate as fully trusted, which removes the
warning permanently for that device:

1. On the device, visit `https://<server-address>:4000/cert` and accept the
   one-time warning first if it hasn't been accepted yet.
2. It downloads `restaurant-pos.crt`.
3. **Windows:** double-click it → Install Certificate → Local Machine →
   place in "Trusted Root Certification Authorities".
4. **Android:** Settings → Security → Encryption & credentials → Install a
   certificate → CA certificate → select the downloaded file.
5. **iPhone/iPad:** opening the file offers to install a profile — accept it
   in Settings, then go to Settings → General → About → Certificate Trust
   Settings and turn on full trust for "restaurant-pos.local".

Optional. The app works fully without this step.
</details>

<details>
<summary>Prefer a terminal?</summary>

```
npm install
node scripts/setup.js
npm run seed
npm start
```
</details>

**Give the server PC a fixed IP** on your router, or the LAN address will change
when it reboots and every till will stop working at once.

### Keeping it running

For a shop, you want the server to start automatically. The simplest reliable
way on Windows:

```
npm install -g pm2
pm2 start src/server.js --name pos
pm2 save
pm2 startup
```

`pm2 logs pos` shows what it's doing; `pm2 restart pos` restarts it.

---

## Day-to-day

**Taking an order.** Order tab → tap items → enter table number → KOT Print for
the kitchen → pick payment mode → Complete Billing.

**If a till loses wifi mid-order**, the order stays on screen. Reconnect and
press Complete Billing again — it cannot double-charge, because each order
carries a one-time key the server recognises.

**Refreshing or closing the browser mid-order** does not lose the order. It's
saved on that device until it's billed or cleared.

**Voiding.** Managers only, from Reports. The order stays in the records with a
reason and a timestamp, and comes out of revenue. It is never deleted — you need
that trail to reconcile the drawer and to file returns.

**Prices** change from the Menu tab. Bills already issued keep the price the
customer actually paid; only new orders use the new price.

**Removing a menu item** hides it from the ordering screen but keeps it in
history, so last month's reports stay correct.

---

## The workbook

`data/pos-data.xlsx`, with five sheets:

| Sheet | What's in it |
|---|---|
| MenuItems | Your menu. `Active = FALSE` means removed from the ordering screen. |
| Orders | One row per bill: total, payment mode, cashier, till, void status. |
| OrderItems | One row per line on each bill, with the price charged at the time. |
| Users | Staff and roles. **PINs are stored in plain text** in the "PIN (visible)" column, by request, so a forgotten PIN can be recovered by opening this file instead of resetting the account. See the security note below. |
| Settings | Invoice counters and internal bookkeeping. Leave alone. |

Money is stored in rupees with two decimals so it reads and sorts normally.

**To edit the menu in Excel:** stop the server (`Ctrl+C` or `pm2 stop pos`),
edit, save, close Excel, start the server. Editing while it runs means your
changes get overwritten the next time the server saves.

**Never** reorder or rename the header row, and never edit `Settings`. Columns
are matched by header name, so inserting a column is safe but renaming one makes
that column invisible to the app.

**Reports → Export to Excel** produces a separate, formatted sales file for a
single day. That's the one to send your accountant — not the live workbook.

---

## Security note on visible PINs

Staff PINs are stored as plain text in the workbook's Users sheet, at the
owner's request, so that a forgotten PIN can be recovered by opening the file
rather than resetting the account. This does not change how sign-in works — the
app still checks a separate hashed copy — so editing the visible PIN column by
hand does nothing; change a PIN from the Staff tab instead.

The trade-off: anyone who can open `pos-data.xlsx` can see every staff PIN,
including the manager's. Treat that file with the same care as a cash drawer
key — don't email it casually, don't leave it on a shared drive open to the
whole shop, and remember that any backup copy carries the PINs too. The PIN is
never sent over the network by the app itself; this exposure is specifically
about who can open the workbook.

---

## Backups

Automatic: on startup, every hour, and before each rewrite. They land in
`data/backups/`, keeping the most recent 30 (change with `BACKUP_KEEP`).

Manual: `npm run backup`, or the Reports tab button.

**Copy `data/backups/` to a USB stick or cloud folder weekly.** Backups on the
same disk as the original protect you from mistakes, not from the disk dying.

### Restoring

1. Stop the server.
2. Copy the backup you want over `data/pos-data.xlsx`.
3. Delete `data/journal.jsonl`.
4. Start the server.

Skipping step 3 replays events from after that backup on top of it, which is
usually not what you want when you're deliberately going back in time.

**Test this once, on a spare machine, before you need it.** A backup you've
never restored is a guess.

---

## When something looks wrong

```
npm run verify
```

Checks that every bill's total matches the sum of its lines, that no lines are
orphaned, that invoice numbers are unique, and that a manager account exists.
Run it after any manual edit to the workbook, and at month-end.

**Status indicators** at the bottom of every till:

| Shows | Means |
|---|---|
| Connected / Workbook current | Everything is fine. |
| Workbook locked — sales still saving | Someone has the file open in Excel. Close it. No data at risk. |
| Saving (n) | n changes not yet written to the file. Normal during a rush. |
| Server unreachable | That till has lost the network, or the server is down. **Stop billing on it** — orders are not being recorded. |

**A till says "Server unreachable".** Check the wifi on that device first, then
that the server PC is on and `pm2 status` shows `pos` online.

**The server won't start.** Read the message — it names the setting that's
wrong. Most often `JWT_SECRET` is still the placeholder.

**"Journal corrupt at line N".** The disk had a problem. Restore from
`data/backups/` as above.

---

## What this system does not do

Worth knowing before you rely on it:

- **No GST/tax breakdown.** Totals only. If you need CGST/SGST on invoices with
  HSN codes, that's a change to the order service and the receipt.
- **No table/floor management.** Table number is a free-text field, not a map.
- **No inventory or stock deduction.**
- **No card processing.** Payment mode is recorded, not taken. Nothing here
  touches card data, which keeps it out of PCI scope entirely — worth preserving.
- **No offline mode.** A till with no network cannot bill. If the server PC dies
  mid-service, everyone stops.
- **The certificate is self-signed**, which is why every device shows a
  one-time trust warning (see "Running it" above). That's normal for a private
  LAN with no public domain name, not a sign of a problem. Do not expose this
  server to the internet as-is regardless — the PIN-based login is built for a
  trusted shop wifi, not the open internet.

## When to move off Excel

The design is sound up to roughly the scale it was built for: a few tills, a few
hundred orders a day, one location. The signals that you've outgrown it:

- Saving the workbook starts taking noticeable seconds (roughly 50,000+ order
  lines, so a year or two of steady trade).
- You want a second location, or reporting across locations.
- You want the owner to see live figures from home.

The migration is smaller than it looks: `src/store/excelStore.js` is the only
file that knows about spreadsheets. Every service above it works through
`store.mutate()` and `store.all()`. Swapping in SQLite means reimplementing that
one file against those same methods, and keeping an hourly Excel export so
nothing about the owner's habits has to change.

---

## Layout

```
pos-app/
├── src/
│   ├── server.js            startup, graceful shutdown
│   ├── app.js               express wiring, security headers, health checks
│   ├── config.js            env loading, validated once at boot
│   ├── lib/                 logger, errors, money, mutex, PIN hashing
│   ├── store/
│   │   ├── schema.js        workbook layout, roles, permissions
│   │   └── excelStore.js    journal + atomic write + replay  ← the important one
│   ├── middleware/          auth, RBAC, error envelope
│   ├── services/            menu, orders, reports — the business rules
│   └── routes/              HTTP surface
├── public/                  the till UI
├── scripts/                 seed, backup, verify
└── data/                    workbook, journal, backups  (never commit this)
```

If you're reading the code for the first time, start with
`src/store/excelStore.js`. The header comment explains why the whole thing is
shaped the way it is.
#   F o o d - P O S  
 