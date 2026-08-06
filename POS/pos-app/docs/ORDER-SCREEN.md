# Order screen — specification and change log

Living document for the order-taking screen. When this screen changes, update
this file in the same change. The point is that six months from now, the
question "why does it work this way?" has an answer that isn't archaeology.

**Status:** current as of 2026-08-05
**Files:** `public/index.html` (markup), `public/app.js` (behaviour),
`src/services/order.service.js` (rules), `src/routes/orders.routes.js` (API)

---

## What this screen is for

A cashier at a counter, during a rush, taking an order from a customer who is
standing in front of them. Every design decision below is subordinate to one
measure: **taps and seconds per order**. A feature that adds a step has to earn
it.

Assume the cashier is not looking at the screen continuously — they are looking
at the customer, the kitchen, and the queue. Anything that requires reading a
sentence to understand has already failed.

---

## Flow

```
Categories  →  Items in category  →  Cart  →  KOT print  →  Payment  →  Done
     ↑                  |
     └──── back ────────┘

Search box short-circuits the first two steps entirely.
```

1. Screen opens on **category tiles** (Soup, Momos, Main Course, …), each
   showing how many items it holds.
2. Tapping a category shows **only that category's items**.
3. Tapping an item (anywhere on the tile, or its `+`) adds one to the cart.
4. **Back arrow** returns to categories to pick the next one.
5. **Search** at any time searches every item across all categories and shows a
   flat result list, bypassing the hierarchy.

### Why category-first

The original screen showed every item in one flat grid. That works for the six
demo items and collapses at real scale — a restaurant with 120 items across 15
categories gives the cashier a wall of tiles to scan, and scanning is slower and
more error-prone than two deliberate taps.

Two taps to reach any item is constant regardless of menu size. A flat grid
degrades linearly with every item added, and it degrades exactly when the
business is doing well.

### Why search still exists

Category navigation is optimal when you know the category. It's worse than a
flat list when you know the item name but not which category it lives under —
which happens constantly with items that could plausibly sit in two places
("Chicken Manchow Soup": Soup, or Chinese?). Search costs one input box and
removes that entire failure mode.

---

## Order numbers

**There are two numbers, deliberately.** Conflating them is the most likely
future mistake, so this section is the important one.

| | Order number | Invoice number |
|---|---|---|
| Looks like | `#42` | `INV-20260805-0001` |
| Who sees it | Customer, kitchen | Accountant, tax authority |
| Resets | Daily | Daily |
| Allocated when | First item added to cart | Payment completes |
| Set by | System, cashier may override | System only |
| Gaps allowed | **Yes** | **No** |
| Duplicates | Allowed (warned) | Never |
| Column | `Orders.Order No` | `Orders.Order ID` |
| Counter | `token_seq_YYYYMMDD` | `invoice_seq_YYYYMMDD` |

The kitchen ticket has to carry a number before any money changes hands —
that's the whole point of a ticket. But an invoice sequence with gaps in it is
an audit question nobody wants to answer. Those two requirements cannot be
satisfied by one counter:

- One counter allocated at **payment** → kitchen tickets have no number.
- One counter allocated at **order start** → abandoned orders leave gaps in the
  invoice sequence.

So there are two. Order numbers may skip (`#41`, `#43`) when a customer walks
away mid-order; that is correct and harmless. Invoice numbers never skip.

### Auto, with an override

The number fills in by itself when the first item is added — the cashier types
nothing in the normal case. The field stays editable, and a badge shows `auto`
or `manual` so an accidental keystroke isn't invisible. A `↺` button returns to
the automatic number.

The override exists because reality at a counter diverges from a counter fast:
a pre-printed slip gets handed out of sequence, a token is reused after a
customer leaves, a phone order needs `PH-3`. A system that refuses those forces
staff into workarounds, and a workaround is worse than an override.

Stored as **text**, not a number — alphanumeric tokens are common, and a numeric
column would silently turn `007` into `7`.

### Allocation is server-side and locked

`POST /api/orders/number` allocates inside `store.mutate()`, the same lock that
guards every write. Two tills starting an order in the same instant get
different numbers. Never compute the next number on the client — with several
tills, two of them will hand `#42` to two different customers.

### Duplicates are warned, not blocked

Some counters cycle a fixed set of token slips through a service, so the same
number legitimately recurs. The cart shows an inline warning if the number is
already used today, and `npm run verify` reports same-day repeats as warnings.
Neither blocks the sale — blocking would be wrong for the cycling case, and
staying silent would be wrong for the accidental case.

### The number survives a refresh

Held in `localStorage` with the cart, along with whether it was overridden. A
till that gets bumped, sleeps, or is reloaded mid-order keeps the same number —
handing the customer one number and the kitchen another is the failure this
prevents.

### Failure behaviour

If the reserve call fails, the field stays empty and the cashier can type one.
If it's still empty at payment, the server allocates one inside the same locked
section that writes the order, so **no order can exist without a number**.
Taking an order is never blocked by something the system can supply itself.

---

## Rules that must not regress

These are load-bearing. Changing any of them needs a deliberate decision, not a
refactor.

- **Prices come from the server.** The cart's prices are for display. On submit,
  the server reprices every line from its own menu. A cart posted from a browser
  is user input; trusting its prices means anyone with devtools sets their own.
- **Only having items gates the buttons.** The cashier no longer types anything
  before billing — one less thing to forget mid-rush.
- **Idempotency key per cart.** Double-tapping Complete Billing, or retrying
  after wifi drops, produces one sale. The customer has already paid once.
- **Offline keeps the cart.** A failed submit leaves the order on screen with
  its key intact. Losing a table's worth of order because wifi blinked is how
  staff stop trusting the system.
- **Every user string is escaped before `innerHTML`.** Item names are typed by
  staff and rendered on every till.
- **KOT will not print without a number.** If the server is unreachable, the
  print is refused. An unnumbered ticket in a busy kitchen is worse than none —
  nobody can match the food to the waiting customer.

---

## Performance

Reads are served from memory, never from the spreadsheet — the workbook is
written to, not read from, during service. Category tiles and item lists are
computed from the in-memory menu, so navigation is instant regardless of menu
size and independent of how large the workbook has grown.

The menu auto-refreshes every 120s so a price changed on the manager's till
reaches the others without a reload, and so two tills never quote different
prices for the same dish.

Writes are debounced (2s, forced at 15s). Under a rush the journal absorbs every
sale immediately; the `.xlsx` rewrite is batched behind it. See the header
comment in `src/store/excelStore.js`.

---

## Deliberately not built yet

Listed so nobody rebuilds the reasoning from scratch:

- **Item modifiers / variants** ("no onion", "half plate"). The single largest
  likely next request. Will need an `order_items` schema change — plan for a
  modifiers column rather than encoding it into the item name, which is the
  tempting shortcut that ruins reporting.
- **Table numbers.** The `tableNumber` column still exists and is nullable.
  Dine-in is a UI change, not a migration. This was left in on purpose.
- **Held / parked orders.** Multiple concurrent carts on one till. The cart is
  currently a single object in `localStorage`; this would make it a keyed map.
- **Item images.** Faster recognition than text for a large menu, but needs
  image storage, upload, and resizing.
- **Category ordering.** Categories currently sort alphabetically. A real
  kitchen wants them in service order (Starters before Mains). Needs a sort
  column on category — which implies categories becoming their own sheet
  instead of a free-text field on each item.

That last one is the most likely structural change. When it happens, categories
move from a string on `menu_items` to a `categories` sheet with `id`, `name`,
`sortOrder`, `isActive` — and `menu_items.category` becomes `categoryId`.

---

## Change log

### 2026-08-05 — Category navigation and order numbers
- Order screen now opens on category tiles; items shown per category.
- Added back navigation and cross-category search.
- Replaced the free-text **Table Number** input with **Order No**: auto-assigned
  by the server when the first item is added, overridable by the cashier, shown
  in large type and printed large on the KOT.
- Added `orderNumber` (text) column to `Orders`; kept `tableNumber` as nullable
  for future dine-in.
- Added `POST /api/orders/number` to reserve a token under lock, with a
  server-side fallback allocation at payment if the till never reserved one.
- Duplicate same-day numbers warn inline and in `verify`, but do not block.
- Reports table and Excel export now lead with Order No, invoice secondary.

### Earlier
- Initial build: flat item grid, table number, cash/card/UPI payment modes,
  KOT print, void with reason, daily reports and Excel export.
