'use strict';

const { z } = require('zod');
const store = require('../store/excelStore');
const money = require('../lib/money');
const { notFound, conflict } = require('../lib/errors');

const menuItemInput = z.object({
  name: z.string().trim().min(1, 'Item name is required').max(80),
  category: z.string().trim().min(1, 'Category is required').max(40),
  // Accepts "350", "350.50", or 350. Bounded because an unbounded price is a
  // typo waiting to print a lakh-rupee bill.
  price: z.union([z.string(), z.number()]).refine((v) => {
    try {
      const m = money.toMinor(v, 'price');
      return m > 0 && m <= 100_000_00;
    } catch {
      return false;
    }
  }, 'Price must be between 0.01 and 100000'),
});

function toApi(item) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    price: money.toMajor(item.priceMinor),
    priceMinor: item.priceMinor,
    isActive: item.isActive,
  };
}

function list({ includeInactive = false } = {}) {
  return store
    .filter('menu_items', (i) => includeInactive || i.isActive)
    .sort((a, b) =>
      a.category === b.category
        ? a.name.localeCompare(b.name)
        : a.category.localeCompare(b.category)
    )
    .map(toApi);
}

async function create(input) {
  const data = menuItemInput.parse(input);
  const priceMinor = money.toMinor(data.price, 'price');

  return store.mutate((s) => {
    const clash = s.find(
      'menu_items',
      (i) =>
        i.isActive &&
        i.name.toLowerCase() === data.name.toLowerCase() &&
        i.category.toLowerCase() === data.category.toLowerCase()
    );
    if (clash) {
      throw conflict(`"${data.name}" already exists in ${data.category}.`);
    }

    // Allocate the id inside the mutation, not before it. Computing max(id)
    // outside the lock is exactly how two tills adding items at the same moment
    // end up with the same id and one item silently overwrites the other.
    const nextId =
      s.all('menu_items').reduce((max, i) => Math.max(max, Number(i.id) || 0), 0) + 1;

    const now = new Date().toISOString();
    const row = {
      id: nextId,
      name: data.name,
      category: data.category,
      priceMinor,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    return {
      events: [{ type: 'menu.upsert', payload: row }],
      result: toApi(row),
    };
  });
}

async function update(id, input) {
  const data = menuItemInput.partial().parse(input);

  return store.mutate((s) => {
    const existing = s.get('menu_items', id);
    if (!existing) throw notFound('That menu item no longer exists.');

    const row = {
      ...existing,
      name: data.name ?? existing.name,
      category: data.category ?? existing.category,
      priceMinor:
        data.price !== undefined ? money.toMinor(data.price, 'price') : existing.priceMinor,
      updatedAt: new Date().toISOString(),
    };

    return { events: [{ type: 'menu.upsert', payload: row }], result: toApi(row) };
  });
}

/**
 * Deactivate rather than delete.
 *
 * Orders from last week reference this item. Removing the row would leave those
 * order lines pointing at nothing, and any report that resolves item names or
 * groups by category would quietly under-report. The item disappears from the
 * ordering grid, which is what the user actually wanted, and history stays
 * intact.
 */
async function deactivate(id) {
  return store.mutate((s) => {
    const existing = s.get('menu_items', id);
    if (!existing) throw notFound('That menu item no longer exists.');
    if (!existing.isActive) return { events: [], result: toApi(existing) };

    return {
      events: [
        { type: 'menu.deactivate', payload: { id: existing.id, updatedAt: new Date().toISOString() } },
      ],
      result: { ...toApi(existing), isActive: false },
    };
  });
}

module.exports = { list, create, update, deactivate, toApi };
