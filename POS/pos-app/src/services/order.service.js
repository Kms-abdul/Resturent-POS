'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const store = require('../store/excelStore');
const money = require('../lib/money');
const { PAYMENT_MODES, ORDER_STATUS } = require('../store/schema');
const { badRequest, notFound, conflict } = require('../lib/errors');

const createOrderInput = z.object({
  // Normally the auto-assigned token the till reserved; may be anything the
  // cashier overrode it to. Optional only as a safety net -- if it is missing
  // the server allocates one rather than writing an order with no number,
  // because an order the kitchen cannot match to a customer is unusable.
  orderNumber: z.string().trim().min(1).max(16).optional(),
  // Optional and unused by the current UI. See schema.js -- the column stays
  // for dine-in table tracking later.
  tableNumber: z.string().trim().max(16).optional(),
  paymentMode: z.enum(PAYMENT_MODES),
  items: z
    .array(
      z.object({
        menuItemId: z.coerce.number().int().positive(),
        quantity: z.coerce.number().min(0.1).max(999),
      })
    )
    .min(1, 'Add at least one item to the order')
    // Bounded so a malformed or malicious request cannot ask the server to
    // build a 50,000-line order and stall every till behind the mutex.
    .max(200, 'An order cannot have more than 200 lines'),
  clientRef: z.string().trim().min(8).max(64),
  terminal: z.string().trim().max(40).optional(),
});

/**
 * Invoice numbers come from a counter in the Settings sheet, not from
 * `orders.length`.
 *
 * Deriving the number from the row count looks simpler and breaks the first
 * time anyone voids an order or deletes a row in Excel: the counter goes
 * backwards and you issue a duplicate invoice number, which is a serious
 * problem for anyone who has to file returns against these records.
 */
function nextInvoiceNumber(s, now) {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const counterKey = `invoice_seq_${datePart}`;
  const current = Number.parseInt(s.setting(counterKey, '0'), 10) || 0;
  const next = current + 1;
  return {
    id: `INV-${datePart}-${String(next).padStart(4, '0')}`,
    counterKey,
    counterValue: next,
  };
}

/**
 * The customer-facing token number.
 *
 * Auto-allocated from a daily counter so the cashier types nothing in the
 * normal case, but the till may send any string it likes -- the counter is a
 * default, not a constraint. Reality at a counter diverges from a counter
 * quickly: a pre-printed slip gets handed out of sequence, a token is reused
 * after the customer leaves, a phone order needs "PH-3". A system that refuses
 * those forces staff to work around it, and a workaround is worse than an
 * override.
 *
 * Stored as text rather than a number so alphanumeric tokens survive and so
 * "007" does not silently become "7".
 *
 * The invoice number above stays strictly server-allocated and gap-free
 * regardless -- that one is the financial record and must never depend on
 * anyone typing it correctly.
 */
function tokenCounterKey(now) {
  return `token_seq_${now.toISOString().slice(0, 10).replace(/-/g, '')}`;
}

function peekTokenNumber(s, now) {
  return (Number.parseInt(s.setting(tokenCounterKey(now), '0'), 10) || 0) + 1;
}

/**
 * Allocate and persist the next token. Runs inside store.mutate so two tills
 * starting an order in the same instant cannot be handed the same number --
 * the read and the write happen in one locked section.
 */
async function reserveOrderNumber() {
  return store.mutate((s) => {
    const now = new Date();
    const value = peekTokenNumber(s, now);
    return {
      events: [
        {
          type: 'setting.set',
          payload: { key: tokenCounterKey(now), value, updatedAt: now.toISOString() },
        },
      ],
      result: { orderNumber: String(value) },
    };
  });
}

/**
 * If an order is cleared, attempt to roll back the counter.
 * Only rolls back if the counter is exactly at the unreserved value,
 * which prevents collisions if another till already advanced it.
 */
async function unreserveOrderNumber(numberStr) {
  const num = parseInt(numberStr, 10);
  if (isNaN(num)) return;

  return store.mutate((s) => {
    const now = new Date();
    const current = peekTokenNumber(s, now) - 1; // peekTokenNumber returns next, so -1 is current
    if (current === num) {
      return {
        events: [
          {
            type: 'setting.set',
            payload: { key: tokenCounterKey(now), value: current - 1, updatedAt: now.toISOString() },
          },
        ],
        result: { success: true },
      };
    }
    return { events: [], result: { success: false } };
  });
}

/**
 * `lines` may be passed explicitly. During creation the order has not been
 * committed to state yet, so looking its lines up from the store would return
 * an empty array and the till would render a bill with no items on it.
 */
function toApi(order, explicitLines) {
  const lines = (explicitLines || store.filter('order_items', (l) => l.orderId === order.id))
    .map((l) => ({
      lineId: l.lineId,
      menuItemId: l.menuItemId,
      name: l.name,
      category: l.category,
      unitPrice: money.toMajor(l.unitPriceMinor),
      quantity: l.quantity,
      lineTotal: money.toMajor(l.lineTotalMinor),
    }));

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    tableNumber: order.tableNumber,
    status: order.status,
    paymentMode: order.paymentMode,
    total: money.toMajor(order.totalMinor),
    totalMinor: order.totalMinor,
    itemCount: order.itemCount,
    createdBy: order.createdBy,
    terminal: order.terminal,
    createdAt: order.createdAt,
    settledAt: order.settledAt,
    voidedAt: order.voidedAt,
    voidReason: order.voidReason,
    fulfillmentStatus: order.fulfillmentStatus || 'pending',
    items: lines,
  };
}

async function create(input, user) {
  const data = createOrderInput.parse(input);

  return store.mutate((s) => {
    // Idempotency check, inside the lock. A cashier double-tapping "Complete
    // Billing" or a till retrying after the wifi blinks must produce one sale,
    // not two -- and the customer has already paid once, so getting this wrong
    // is a refund conversation, not a cosmetic bug.
    const existing = s.find('orders', (o) => o.clientRef === data.clientRef);
    if (existing) {
      return { events: [], result: { order: toApi(existing), duplicate: true } };
    }

    // Price from the server's menu, never from the client's cart. A cart posted
    // from a browser is user input; trusting the price in it means anyone who
    // can open devtools can buy a biryani for one rupee.
    const lines = [];
    let totalMinor = 0;
    let itemCount = 0;
    
    const now = new Date();

    for (const requested of data.items) {
      const item = s.get('menu_items', requested.menuItemId);
      if (!item) {
        throw badRequest(`Menu item ${requested.menuItemId} does not exist.`);
      }
      if (!item.isActive) {
        throw conflict(`"${item.name}" was removed from the menu. Remove it from the order.`);
      }

      const lineTotalMinor = item.priceMinor * requested.quantity;
      totalMinor += lineTotalMinor;
      itemCount += requested.quantity;

      lines.push({
        lineId: crypto.randomUUID(),
        orderId: null, // filled once the invoice number is allocated
        createdAt: now.toISOString(),
        menuItemId: item.id,
        name: item.name,
        category: item.category,
        // Unit price is copied onto the line, not referenced. When the owner
        // raises the price of butter chicken next month, last month's bills
        // must still show what the customer actually paid.
        unitPriceMinor: item.priceMinor,
        quantity: requested.quantity,
        lineTotalMinor,
      });
    }
    const { id, counterKey, counterValue } = nextInvoiceNumber(s, now);
    for (const line of lines) line.orderId = id;

    // Safety net for the case where the till never reserved one -- a failed
    // reserve call, or a client that skipped it. Allocating here, inside the
    // same lock, guarantees no order is ever written without a number.
    const autoToken = data.orderNumber ? null : peekTokenNumber(s, now);
    const tokenEvents = autoToken
      ? [
          {
            type: 'setting.set',
            payload: {
              key: tokenCounterKey(now),
              value: autoToken,
              updatedAt: now.toISOString(),
            },
          },
        ]
      : [];

    const order = {
      id,
      orderNumber: data.orderNumber || String(autoToken),
      tableNumber: data.tableNumber || null,
      status: ORDER_STATUS.SETTLED,
      paymentMode: data.paymentMode,
      totalMinor,
      itemCount,
      createdBy: user.name,
      terminal: data.terminal || 'unknown',
      clientRef: data.clientRef,
      fulfillmentStatus: 'pending',
      createdAt: now.toISOString(),
      settledAt: now.toISOString(),
      voidedAt: null,
      voidReason: null,
    };

    return {
      events: [
        { type: 'order.create', payload: { order, items: lines } },
        {
          type: 'setting.set',
          payload: { key: counterKey, value: counterValue, updatedAt: now.toISOString() },
        },
        ...tokenEvents,
      ],
      result: { order: toApi(order, lines), duplicate: false },
    };
  });
}

/**
 * Voiding writes a status change; it never removes the row.
 *
 * A sales record that can disappear is one the owner cannot reconcile against
 * the cash drawer and one no tax authority will accept. Keeping the original
 * with a reason and a timestamp is both the honest record and the more useful
 * one -- "why was this voided" is a question that gets asked.
 */
async function voidOrder(id, reason, user) {
  const parsed = z
    .object({ reason: z.string().trim().min(3, 'Give a reason for the void').max(120) })
    .parse({ reason });

  return store.mutate((s) => {
    const order = s.get('orders', id);
    if (!order) throw notFound('That order does not exist.');
    if (order.status === ORDER_STATUS.VOIDED) {
      return { events: [], result: toApi(order) };
    }

    const voidedAt = new Date().toISOString();
    return {
      events: [
        {
          type: 'order.void',
          payload: { id: order.id, voidedAt, voidReason: `${parsed.reason} (by ${user.name})` },
        },
      ],
      result: { ...toApi(order), status: ORDER_STATUS.VOIDED, voidedAt },
    };
  });
}

async function markFulfilled(id, user) {
  return store.mutate((s) => {
    const order = s.get('orders', id);
    if (!order) throw notFound('That order does not exist.');
    if (order.status === ORDER_STATUS.VOIDED) throw badRequest('Cannot fulfill a voided order.');

    return {
      events: [
        {
          type: 'order.fulfill',
          payload: { id: order.id, fulfillmentStatus: 'completed' },
        },
      ],
      result: { ...toApi(order), fulfillmentStatus: 'completed' },
    };
  });
}

function get(id) {
  const order = store.get('orders', id);
  if (!order) throw notFound('That order does not exist.');
  return toApi(order);
}

function listForDay(dateStr) {
  // Same validation as reports: a date arriving from a query string is user
  // input regardless of which control produced it.
  const day = require('./report.service').parseBusinessDate(dateStr);
  return store
    .filter('orders', (o) => String(o.createdAt || '').slice(0, 10) === day)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    // Not `.map(toApi)` -- map passes the array index as the second argument,
    // which toApi would take as an explicit line list and then try to iterate.
    .map((o) => toApi(o));
}

module.exports = { create, voidOrder, get, listForDay, toApi, reserveOrderNumber, unreserveOrderNumber, markFulfilled };
