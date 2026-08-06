'use strict';

const ExcelJS = require('exceljs');
const store = require('../store/excelStore');
const money = require('../lib/money');
const { ORDER_STATUS } = require('../store/schema');
const { badRequest } = require('../lib/errors');

/**
 * Reports read from memory and compute in integer paise, converting to rupees
 * only at the boundary. Voided orders are excluded from every revenue figure
 * but counted separately -- an owner needs to see that eleven orders were
 * voided today, because that is either a training problem or a theft problem.
 */

/**
 * Every date that enters this module goes through here.
 *
 * It is not only about rejecting nonsense: `day` ends up in the export
 * filename, which is echoed in a Content-Disposition header. An unvalidated
 * value there is a header-injection vector, and "it comes from a date picker"
 * is not a control -- the query string is whatever the caller sends.
 */
function parseBusinessDate(dateStr) {
  if (!dateStr) return new Date().toISOString().slice(0, 10);
  const s = String(dateStr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw badRequest('Date must be in YYYY-MM-DD format.');
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw badRequest('That is not a real date.');
  }
  return s;
}

function dailySummary(dateStr) {
  const day = parseBusinessDate(dateStr);
  const all = store.filter('orders', (o) => String(o.createdAt || '').slice(0, 10) === day);
  const settled = all.filter((o) => o.status === ORDER_STATUS.SETTLED);
  const voided = all.filter((o) => o.status === ORDER_STATUS.VOIDED);

  const revenueMinor = settled.reduce((sum, o) => sum + (o.totalMinor || 0), 0);

  const byPayment = {};
  for (const o of settled) {
    const mode = o.paymentMode || 'unknown';
    byPayment[mode] = byPayment[mode] || { count: 0, totalMinor: 0 };
    byPayment[mode].count += 1;
    byPayment[mode].totalMinor += o.totalMinor || 0;
  }

  const settledIds = new Set(settled.map((o) => o.id));
  const itemTotals = new Map();
  for (const line of store.all('order_items')) {
    if (!settledIds.has(line.orderId)) continue;
    const key = `${line.menuItemId}`;
    const row = itemTotals.get(key) || {
      menuItemId: line.menuItemId,
      name: line.name,
      category: line.category,
      quantity: 0,
      revenueMinor: 0,
    };
    row.quantity += line.quantity || 0;
    row.revenueMinor += line.lineTotalMinor || 0;
    itemTotals.set(key, row);
  }

  const topItems = Array.from(itemTotals.values())
    .sort((a, b) => b.revenueMinor - a.revenueMinor)
    .slice(0, 20)
    .map((r) => ({ ...r, revenue: money.toMajor(r.revenueMinor) }));

  return {
    date: day,
    orderCount: settled.length,
    voidedCount: voided.length,
    revenue: money.toMajor(revenueMinor),
    revenueMinor,
    averageOrderValue: settled.length ? money.toMajor(Math.round(revenueMinor / settled.length)) : 0,
    byPaymentMode: Object.fromEntries(
      Object.entries(byPayment).map(([k, v]) => [
        k,
        { count: v.count, total: money.toMajor(v.totalMinor) },
      ])
    ),
    topItems,
  };
}

/**
 * Export a day's sales as a formatted .xlsx.
 *
 * Deliberately xlsx and not csv: a csv re-opens in Excel with every type-
 * coercion trap live again -- table "007" becomes 7, invoice IDs get mangled,
 * dates get reinterpreted by locale. Generating the real format means the file
 * the accountant opens says what we meant.
 */
async function exportDayWorkbook(dateStr) {
  const day = parseBusinessDate(dateStr);
  const summary = dailySummary(day);
  const orders = store
    .filter('orders', (o) => String(o.createdAt || '').slice(0, 10) === day)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const orderIds = new Set(orders.map((o) => o.id));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Restaurant POS';
  wb.created = new Date();

  // A metadata sheet answers "which export is this?" months later, when there
  // are nine similarly-named files in the accountant's inbox.
  const meta = wb.addWorksheet('About');
  meta.columns = [{ width: 26 }, { width: 46 }];
  meta.addRows([
    ['Report', 'Daily sales'],
    ['Business date', day],
    ['Generated at', new Date().toISOString()],
    ['Orders (settled)', summary.orderCount],
    ['Orders (voided)', summary.voidedCount],
    ['Revenue', summary.revenue],
    ['Average order value', summary.averageOrderValue],
    ['Note', 'Voided orders are listed but excluded from all revenue figures.'],
  ]);
  meta.getColumn(1).font = { bold: true };

  const os = wb.addWorksheet('Orders', { views: [{ state: 'frozen', ySplit: 1 }] });
  os.columns = [
    { header: 'Order No', key: 'orderNumber', width: 10 },
    { header: 'Invoice', key: 'id', width: 20 },
    { header: 'Time', key: 'time', width: 20 },
    { header: 'Table', key: 'table', width: 10 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Payment', key: 'payment', width: 12 },
    { header: 'Items', key: 'items', width: 8 },
    { header: 'Total', key: 'total', width: 14 },
    { header: 'Cashier', key: 'cashier', width: 18 },
    { header: 'Void Reason', key: 'voidReason', width: 30 },
  ];
  os.getRow(1).font = { bold: true };
  for (const o of orders) {
    os.addRow({
      orderNumber: o.orderNumber ?? null,
      id: o.id,
      time: new Date(o.createdAt),
      // Blank rather than the string "null" for the orders taken since table
      // numbers stopped being collected. A cell reading "null" looks like a
      // bug to whoever opens the report, and to any formula referencing it.
      table: o.tableNumber ? String(o.tableNumber) : '',
      status: o.status,
      payment: o.paymentMode,
      items: o.itemCount,
      total: money.toMajor(o.totalMinor),
      cashier: o.createdBy,
      voidReason: o.voidReason || '',
    });
  }
  os.getColumn('total').numFmt = '#,##0.00';
  os.getColumn('time').numFmt = 'yyyy-mm-dd hh:mm:ss';

  const ls = wb.addWorksheet('Order Lines', { views: [{ state: 'frozen', ySplit: 1 }] });
  ls.columns = [
    { header: 'Order ID', key: 'orderId', width: 20 },
    { header: 'Item', key: 'name', width: 30 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Unit Price', key: 'unit', width: 12 },
    { header: 'Qty', key: 'qty', width: 8 },
    { header: 'Line Total', key: 'lineTotal', width: 14 },
  ];
  ls.getRow(1).font = { bold: true };
  for (const l of store.all('order_items')) {
    if (!orderIds.has(l.orderId)) continue;
    ls.addRow({
      orderId: l.orderId,
      name: l.name,
      category: l.category,
      unit: money.toMajor(l.unitPriceMinor),
      qty: l.quantity,
      lineTotal: money.toMajor(l.lineTotalMinor),
    });
  }
  ls.getColumn('unit').numFmt = '#,##0.00';
  ls.getColumn('lineTotal').numFmt = '#,##0.00';

  const ts = wb.addWorksheet('Item Totals', { views: [{ state: 'frozen', ySplit: 1 }] });
  ts.columns = [
    { header: 'Item', key: 'name', width: 30 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Qty Sold', key: 'qty', width: 12 },
    { header: 'Revenue', key: 'revenue', width: 14 },
  ];
  ts.getRow(1).font = { bold: true };
  for (const r of summary.topItems) {
    ts.addRow({ name: r.name, category: r.category, qty: r.quantity, revenue: r.revenue });
  }
  ts.getColumn('revenue').numFmt = '#,##0.00';

  return { workbook: wb, filename: `sales-${day}.xlsx` };
}

module.exports = { dailySummary, exportDayWorkbook, parseBusinessDate };
