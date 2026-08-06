'use strict';

/**
 * First-run setup: creates the workbook, a manager and a cashier, and a starter
 * menu.
 *
 * PINs are generated randomly and printed once. They are not hardcoded, because
 * a default PIN that ships in a repo is a default PIN that is still in place
 * three years later on every install.
 */

const crypto = require('crypto');
const store = require('../src/store/excelStore');
const { hashPin } = require('../src/lib/pin');
const money = require('../src/lib/money');
const { ROLES } = require('../src/store/schema');

const STARTER_MENU = [
  ['Butter Chicken', 'Main Course', 350],
  ['Paneer Tikka', 'Appetizer', 250],
  ['Dal Makhani', 'Main Course', 300],
  ['Garlic Naan', 'Breads', 80],
  ['Biryani', 'Rice', 400],
  ['Mango Lassi', 'Beverages', 120],
];

function randomPin() {
  // crypto, not Math.random: predictable staff PINs are worth as little as no
  // PINs at all.
  return String(crypto.randomInt(1000, 10000));
}

async function main() {
  await store.init();

  if (store.all('users').length > 0) {
    console.log('\nUsers already exist. Seeding aborted so nothing is overwritten.');
    console.log('To start over, move data/pos-data.xlsx and data/journal.jsonl aside.\n');
    await store.close();
    process.exit(0);
  }

  const managerPin = randomPin();
  const cashierPin = randomPin();
  const now = new Date().toISOString();

  const manager = { ...(await hashPin(managerPin)) };
  const cashier = { ...(await hashPin(cashierPin)) };

  await store.mutate(() => ({
    events: [
      {
        type: 'user.upsert',
        payload: {
          id: 1,
          name: 'Manager',
          role: ROLES.MANAGER,
          pin: managerPin,
          pinHash: manager.pinHash,
          pinSalt: manager.pinSalt,
          isActive: true,
          createdAt: now,
        },
      },
      {
        type: 'user.upsert',
        payload: {
          id: 2,
          name: 'Cashier',
          role: ROLES.CASHIER,
          pin: cashierPin,
          pinHash: cashier.pinHash,
          pinSalt: cashier.pinSalt,
          isActive: true,
          createdAt: now,
        },
      },
      ...STARTER_MENU.map(([name, category, price], i) => ({
        type: 'menu.upsert',
        payload: {
          id: i + 1,
          name,
          category,
          priceMinor: money.toMinor(price),
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      })),
      {
        type: 'setting.set',
        payload: { key: 'restaurant_name', value: 'Restaurant POS', updatedAt: now },
      },
    ],
    result: null,
  }));

  await store.flush({ force: true });

  console.log('\n' + '='.repeat(62));
  console.log('  SETUP COMPLETE - write these down now, they are not shown again');
  console.log('='.repeat(62));
  console.log(`  Manager   name: Manager    PIN: ${managerPin}`);
  console.log(`  Cashier   name: Cashier    PIN: ${cashierPin}`);
  console.log('='.repeat(62));
  console.log('  Change them from the Staff screen after your first sign-in.');
  console.log('  Start the server with:  npm start\n');

  await store.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
