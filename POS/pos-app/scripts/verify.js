'use strict';

/**
 * Integrity check. Run it before month-end, after any manual edit to the
 * workbook, and any time something looks wrong.
 *
 * The point is to catch the specific ways a spreadsheet-backed store goes bad:
 * someone edits a total by hand in Excel, deletes an order row but not its
 * lines, or re-sorts a sheet and breaks nothing visible while breaking a lot
 * that is invisible. These are silent failures -- nothing throws, the numbers
 * just stop being true. Checking is the only way to know.
 */

const store = require('../src/store/excelStore');
const money = require('../src/lib/money');

async function main() {
  await store.init();

  const problems = [];
  const warnings = [];

  const orders = store.all('orders');
  const lines = store.all('order_items');
  const menu = store.all('menu_items');

  const orderIds = new Set(orders.map((o) => String(o.id)));
  const menuIds = new Set(menu.map((m) => String(m.id)));

  // 1. Every order line belongs to an order that exists.
  for (const l of lines) {
    if (!orderIds.has(String(l.orderId))) {
      problems.push(`Order line ${l.lineId} references missing order ${l.orderId}`);
    }
    if (l.menuItemId && !menuIds.has(String(l.menuItemId))) {
      warnings.push(`Order line ${l.lineId} references missing menu item ${l.menuItemId}`);
    }
  }

  // 2. Every order has at least one line.
  const linesByOrder = new Map();
  for (const l of lines) {
    const arr = linesByOrder.get(String(l.orderId)) || [];
    arr.push(l);
    linesByOrder.set(String(l.orderId), arr);
  }
  for (const o of orders) {
    if (!linesByOrder.has(String(o.id))) {
      problems.push(`Order ${o.id} has no line items`);
    }
  }

  // 3. Each line total equals unit price x quantity, and each order total
  //    equals the sum of its lines. This is the check that catches a hand-edit.
  for (const l of lines) {
    const expected = (l.unitPriceMinor || 0) * (l.quantity || 0);
    if (expected !== l.lineTotalMinor) {
      problems.push(
        `Line ${l.lineId}: total ${money.format(l.lineTotalMinor)} does not equal ` +
          `${money.format(l.unitPriceMinor)} x ${l.quantity} = ${money.format(expected)}`
      );
    }
  }
  for (const o of orders) {
    const sum = (linesByOrder.get(String(o.id)) || []).reduce(
      (acc, l) => acc + (l.lineTotalMinor || 0),
      0
    );
    if (sum !== o.totalMinor) {
      problems.push(
        `Order ${o.id}: total ${money.format(o.totalMinor)} does not equal the sum of its ` +
          `lines ${money.format(sum)}`
      );
    }
  }

  // 4. Invoice numbers are unique.
  const seen = new Set();
  for (const o of orders) {
    if (seen.has(String(o.id))) problems.push(`Duplicate invoice number ${o.id}`);
    seen.add(String(o.id));
  }

  // 5. Every order has a payment mode and a cashier, so end-of-day
  //    reconciliation has something to reconcile against.
  for (const o of orders) {
    if (o.status === 'settled' && !o.paymentMode) {
      warnings.push(`Order ${o.id} has no payment mode recorded`);
    }
    if (!o.createdBy) warnings.push(`Order ${o.id} has no cashier recorded`);
  }

  // 6. Every order has a customer-facing number, and no two orders on the same
  //    day share one. Duplicated tokens mean two customers holding the same
  //    slip, which the kitchen cannot resolve.
  const tokensByDay = new Map();
  for (const o of orders) {
    if (!o.orderNumber) {
      warnings.push(`Order ${o.id} has no customer-facing order number`);
      continue;
    }
    const day = String(o.createdAt || '').slice(0, 10);
    const key = `${day}#${o.orderNumber}`;
    if (tokensByDay.has(key)) {
      // A warning, not a problem: counters that recycle a fixed set of token
      // slips through a service will legitimately repeat numbers. Worth seeing,
      // not worth failing the check over.
      warnings.push(
        `Order number #${o.orderNumber} on ${day} is used by both ` +
          `${tokensByDay.get(key)} and ${o.id}`
      );
    }
    tokensByDay.set(key, o.id);
  }

  // 7. At least one active manager exists.
  const managers = store.filter('users', (u) => u.isActive && u.role === 'manager');
  if (managers.length === 0) problems.push('No active manager account exists');

  console.log('\nIntegrity check');
  console.log('-'.repeat(50));
  console.log(`Menu items:  ${menu.length}`);
  console.log(`Orders:      ${orders.length}`);
  console.log(`Order lines: ${lines.length}`);
  console.log(`Pending journal events: ${store.pendingEvents}`);
  console.log('-'.repeat(50));

  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    warnings.slice(0, 50).forEach((w) => console.log(`  ! ${w}`));
  }

  if (problems.length === 0) {
    console.log('\nNo problems found.\n');
  } else {
    console.log(`\n${problems.length} problem(s):`);
    problems.slice(0, 50).forEach((p) => console.log(`  X ${p}`));
    console.log(
      '\nIf these appeared after editing the workbook in Excel, restore the most ' +
        `recent good backup from data/backups and restart.\n`
    );
  }

  await store.close();
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Verify failed:', err);
  process.exit(1);
});
