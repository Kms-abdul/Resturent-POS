# POS, retail and inventory domain notes

Read before designing anything involving point-of-sale, ordering, inventory, or
restaurant/retail back-office. These requirements are painful to retrofit and easy to miss
if the system is treated as generic CRUD.

## Sales records are immutable

A settled sale is a financial record. Never delete it, never edit it in place. Corrections
happen by writing a new record: a void with a reason and a timestamp, or an offsetting
refund line. Anything else means the day's takings cannot be reconciled against the cash
drawer, and in most jurisdictions it fails an audit outright.

Practically: `status` and `voidedAt` columns, never a `DELETE`. Reports exclude voided
sales from revenue but report the void count separately — a spike in voids is either a
training problem or theft, and either way the owner needs to see it.

## Prices are copied onto the line, never referenced

When the owner raises the price of a dish, last month's bills must still show what the
customer actually paid. Copy `unitPrice` onto the order line at the time of sale. A report
that joins to the current menu price silently rewrites history every time a price changes.

Same logic for item names and tax rates: snapshot what applied at the moment of sale.

## Menu and product deletion is deactivation

Orders reference items. Deleting the row orphans those lines and breaks every report that
resolves names or groups by category. Set `isActive = false` — the item disappears from
the ordering screen, which is what the user actually asked for, and history survives.

## Money is integer minor units

Store paise/cents as integers, never floats. A POS performs thousands of additions a day;
float drift produces bills that don't match the sum of their lines and end-of-day totals
that never quite close. Those bugs surface weeks later as "the numbers look wrong", which
is close to impossible to debug after the fact.

## Idempotency on every sale

Cashiers double-tap. Tills lose wifi mid-request and retry. Without an idempotency key the
customer gets charged twice and you find out during a refund conversation. Have the client
mint a key per cart, send it on submit, and have the server check for an existing sale with
that key inside the same lock that allocates the invoice number.

## Invoice numbers come from a counter, not a row count

`orders.length + 1` breaks the first time anyone voids an order or deletes a row: the
counter goes backwards and you issue a duplicate invoice number. Keep an explicit
monotonic counter, allocate it under the same lock as the insert, and never reuse.

## Offline behaviour is a product decision, not a technical detail

Ask early: if the network drops mid-service, does the till keep taking orders or stop?

- **Stop** is simpler and honest. The till shows a clear "not recording" state and staff
  fall back to paper. Choose this unless offline is a stated requirement.
- **Keep going** means local durable storage on the till, a sync queue, conflict rules,
  and locally-allocated ID ranges so two tills don't collide. That is a substantial
  subsystem — price it before promising it.

The failure that matters is neither: a till that looks normal while silently discarding
sales. Whatever you choose, connection state must be visible on screen at all times.

## Cash drawer and shift reconciliation

If the business handles cash, they will need shifts: open with a declared float, record
sales by payment mode, close with a counted amount, and show the variance. Without it,
"the drawer is short" has no attributable cause. Record payment mode on every sale from
day one even if shifts come later — retrofitting the mode onto historical sales is
impossible.

## Card data and PCI scope

Do not store, log, or transmit card numbers. Use a payment terminal or a processor's
hosted fields so card data never touches your servers. Recording a payment *mode* of
"card" is fine and carries no PCI burden; recording a PAN drags the whole system into a
full PCI-DSS audit. This is the single highest-leverage scoping decision in a POS build —
protect it deliberately.

## Inventory as an append-only ledger

If stock is tracked, model movements as immutable rows (`+50 received`, `-2 sold`,
`-1 wastage`) and derive the on-hand quantity as their sum. A mutable `quantity` column
updated in place gives you a number nobody can explain and no way to reconstruct how it
got there. The ledger also makes stocktake variance a natural query rather than a
forensics exercise.

Expect negative stock. It happens constantly in real kitchens — items get sold before the
delivery is entered. Warn, don't block; blocking a sale because the paperwork is behind
means staff stop using the system.

## Kitchen tickets are not receipts

The KOT is for the kitchen: item, quantity, modifiers, table, time, and nothing else.
Prices on a kitchen ticket are noise. Print it the moment the order is placed, before
payment — the kitchen starts cooking while the customer is still deciding on dessert.

## Peak load is the design point

A restaurant's entire day happens in two ninety-minute windows. Average throughput is
meaningless. Design for the dinner rush: every till submitting at once, the manager
running a report, and the printer queue backed up. If a report can lock the sales table,
it will do so at 8pm on a Saturday.

## Tax varies more than you expect

Rates differ by item category, by dine-in versus takeaway, and by jurisdiction. Tax may be
inclusive (price shown includes tax, back it out for the invoice) or exclusive (added at
the end). Ask which, and store the resolved rate and amount on each line — recomputing
historical tax from current rates produces invoices that don't match what was collected.

Even when the first version ships without tax, leave the seam: line-level amounts, a
resolved rate field, and receipt rendering that can grow a breakdown section.
