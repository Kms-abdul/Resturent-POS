'use strict';

const { badRequest } = require('./errors');

/**
 * All money in this system is stored and computed as an integer number of paise
 * (minor units). Never as a float.
 *
 * The reason is not theoretical. 0.1 + 0.2 === 0.30000000000000004 in every
 * JavaScript runtime, and a POS adds prices thousands of times a day. Floats
 * produce bills that are off by a paisa, totals that don't match the sum of
 * their lines, and end-of-day reconciliation that never quite closes -- and
 * every one of those bugs is reported weeks later as "the numbers look wrong",
 * which is close to impossible to debug after the fact.
 *
 * Convert at the edges: parse rupees on input, format rupees on output, and
 * keep integers everywhere in between.
 */

const MINOR_PER_MAJOR = 100;

/** Parse a user-entered rupee amount ("350", "350.50", 350.5) into paise. */
function toMinor(value, fieldName = 'amount') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw badRequest(`${fieldName} is not a valid number`);
    return Math.round(value * MINOR_PER_MAJOR);
  }
  if (typeof value !== 'string') throw badRequest(`${fieldName} is not a valid number`);

  // Tolerate what people actually type and what Excel actually stores:
  // currency symbols, thousands separators, stray whitespace.
  const cleaned = value.replace(/[^0-9.\-]/g, '').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === '.') {
    throw badRequest(`${fieldName} is not a valid number`);
  }
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) throw badRequest(`${fieldName} is not a valid number`);
  return Math.round(n * MINOR_PER_MAJOR);
}

/** Convert paise back to a rupee number, for writing into Excel cells. */
function toMajor(minor) {
  return Math.round(minor) / MINOR_PER_MAJOR;
}

/** Format paise for display: 35050 -> "350.50". Symbol is added by the caller. */
function format(minor) {
  const negative = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const major = Math.floor(abs / MINOR_PER_MAJOR);
  const rest = String(abs % MINOR_PER_MAJOR).padStart(2, '0');
  return `${negative ? '-' : ''}${major}.${rest}`;
}

module.exports = { MINOR_PER_MAJOR, toMinor, toMajor, format };
