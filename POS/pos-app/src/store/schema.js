'use strict';

/**
 * The workbook layout, declared in one place.
 *
 * Everything about reading and writing the .xlsx is driven from this table, so
 * adding a column is a one-line change here rather than an edit in four files
 * that will inevitably drift apart. `key` is the property name in memory,
 * `header` is what a human sees in Excel, and `type` drives both parsing on read
 * and cell formatting on write.
 *
 * Money columns are declared as `money`: stored in memory as integer paise,
 * written to Excel as a rupee number with a currency format so the sheet is
 * still readable and sortable by a human. See lib/money.js for why.
 */

const SHEETS = {
  menu_items: {
    name: 'MenuItems',
    idKey: 'id',
    columns: [
      { key: 'id', header: 'ID', type: 'int', width: 8 },
      { key: 'name', header: 'Name', type: 'text', width: 30 },
      { key: 'category', header: 'Category', type: 'text', width: 18 },
      { key: 'priceMinor', header: 'Price', type: 'money', width: 12 },
      { key: 'isActive', header: 'Active', type: 'bool', width: 10 },
      { key: 'createdAt', header: 'Created At', type: 'datetime', width: 20 },
      { key: 'updatedAt', header: 'Updated At', type: 'datetime', width: 20 },
    ],
  },

  /**
   * Orders are append-only once settled. A void writes a new row with a
   * `voidedAt` stamp rather than deleting the original, because a sales record
   * that can vanish is a sales record no tax authority will accept and no owner
   * can reconcile against the cash drawer.
   */
  orders: {
    name: 'Orders',
    idKey: 'id',
    columns: [
      // `id` is the invoice number (INV-YYYYMMDD-0001). It never has gaps,
      // because a missing invoice number is an audit question nobody wants to
      // answer. Allocated at payment.
      { key: 'id', header: 'Order ID', type: 'text', width: 20 },
      // `orderNumber` is the short token the customer and kitchen see, typed by
      // the cashier -- usually off a pre-printed slip. Stored as text, not a
      // number, because tokens are frequently alphanumeric ("A12", "T-7") and
      // because a numeric column silently strips leading zeros, turning token
      // "007" into "7" on the ticket.
      //
      // Deliberately NOT unique: many counters cycle a fixed set of token slips
      // through the day, so the same number legitimately appears more than once.
      // `npm run verify` reports same-day repeats as a warning so they are
      // visible without being blocked.
      { key: 'orderNumber', header: 'Order No', type: 'text', width: 12 },
      // Optional, and deliberately kept even though the current UI does not
      // collect it. Dine-in table tracking is a predictable next requirement,
      // and leaving the column in place means adding it later is a UI change
      // rather than a data migration across every historical row.
      { key: 'tableNumber', header: 'Table', type: 'text', width: 10 },
      { key: 'status', header: 'Status', type: 'text', width: 12 },
      { key: 'paymentMode', header: 'Payment Mode', type: 'text', width: 14 },
      { key: 'totalMinor', header: 'Total', type: 'money', width: 12 },
      { key: 'itemCount', header: 'Items', type: 'int', width: 8 },
      { key: 'createdBy', header: 'Cashier', type: 'text', width: 16 },
      { key: 'terminal', header: 'Terminal', type: 'text', width: 16 },
      // Client-generated idempotency key. A cashier double-tapping "Complete
      // Billing", or a till retrying after the wifi drops mid-request, must not
      // produce two sales for one meal. Persisting the key rather than holding
      // it in memory means the guarantee survives a server restart too.
      { key: 'clientRef', header: 'Client Ref', type: 'text', width: 38 },
      { key: 'createdAt', header: 'Created At', type: 'datetime', width: 20 },
      { key: 'settledAt', header: 'Settled At', type: 'datetime', width: 20 },
      { key: 'voidedAt', header: 'Voided At', type: 'datetime', width: 20 },
      { key: 'voidReason', header: 'Void Reason', type: 'text', width: 28 },
    ],
  },

  order_items: {
    name: 'OrderItems',
    idKey: 'lineId',
    columns: [
      { key: 'lineId', header: 'Line ID', type: 'text', width: 26 },
      { key: 'orderId', header: 'Order ID', type: 'text', width: 20 },
      { key: 'menuItemId', header: 'Menu Item ID', type: 'int', width: 14 },
      { key: 'name', header: 'Item', type: 'text', width: 30 },
      { key: 'category', header: 'Category', type: 'text', width: 18 },
      { key: 'unitPriceMinor', header: 'Unit Price', type: 'money', width: 12 },
      { key: 'quantity', header: 'Qty', type: 'int', width: 8 },
      { key: 'lineTotalMinor', header: 'Line Total', type: 'money', width: 12 },
    ],
  },

  users: {
    name: 'Users',
    idKey: 'id',
    columns: [
      { key: 'id', header: 'ID', type: 'int', width: 8 },
      { key: 'name', header: 'Name', type: 'text', width: 22 },
      { key: 'role', header: 'Role', type: 'text', width: 12 },
      // Readable by design, at the owner's explicit request, so a forgotten PIN
      // is "open the workbook" instead of a full account reseed. Sign-in itself
      // never reads this column -- it checks pinHash/pinSalt below -- so a
      // mistaken edit here cannot lock anyone out or let someone forge a login
      // by editing the sheet. Never returned by the API; only visible to
      // whoever can open pos-data.xlsx. Treat that file accordingly.
      { key: 'pin', header: 'PIN (visible)', type: 'text', width: 14 },
      { key: 'pinHash', header: 'PIN Hash', type: 'text', width: 44 },
      { key: 'pinSalt', header: 'PIN Salt', type: 'text', width: 34 },
      { key: 'isActive', header: 'Active', type: 'bool', width: 10 },
      { key: 'createdAt', header: 'Created At', type: 'datetime', width: 20 },
    ],
  },

  /**
   * Key/value settings, including the invoice counter. Keeping the counter in
   * the workbook rather than deriving it from `orders.length` means a voided or
   * manually deleted row can never cause a duplicate invoice number.
   */
  settings: {
    name: 'Settings',
    idKey: 'key',
    columns: [
      { key: 'key', header: 'Key', type: 'text', width: 26 },
      { key: 'value', header: 'Value', type: 'text', width: 44 },
      { key: 'updatedAt', header: 'Updated At', type: 'datetime', width: 20 },
    ],
  },
};

/** Order matters: this is the tab order a human sees when they open the file. */
const SHEET_ORDER = ['menu_items', 'orders', 'order_items', 'users', 'settings'];

const ROLES = Object.freeze({ CASHIER: 'cashier', MANAGER: 'manager' });

const PERMISSIONS = Object.freeze({
  cashier: ['orders:create', 'orders:read', 'menu:read', 'reports:read:own'],
  manager: [
    'orders:create',
    'orders:read',
    'orders:void',
    'menu:read',
    'menu:write',
    'reports:read',
    'users:manage',
    'data:export',
  ],
});

const PAYMENT_MODES = Object.freeze(['cash', 'card', 'upi']);
const ORDER_STATUS = Object.freeze({ SETTLED: 'settled', VOIDED: 'voided' });

module.exports = { SHEETS, SHEET_ORDER, ROLES, PERMISSIONS, PAYMENT_MODES, ORDER_STATUS };
