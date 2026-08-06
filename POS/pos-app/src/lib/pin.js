'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

/**
 * PIN hashing using Node's built-in scrypt.
 *
 * Why scrypt rather than bcrypt or argon2: both of those are native modules,
 * and this app has to install cleanly on a random Windows PC in a restaurant
 * back office where there is no build toolchain. A failed `npm install` at
 * setup time is a real cost. scrypt is memory-hard, in the standard library,
 * and needs no compiler.
 *
 * Why hash a 4-digit PIN at all, when the keyspace is only 10,000: because the
 * hashes live in a spreadsheet the owner will email to their accountant, copy
 * to a USB stick, and leave on a shared drive. Plaintext PINs in that file
 * would be handed out with it. Hashing does not make a short PIN strong -- rate
 * limiting on the login endpoint does that -- but it stops casual disclosure.
 */

const KEYLEN = 32;
const COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(String(pin), salt, KEYLEN, COST);
  return { pinHash: derived.toString('hex'), pinSalt: salt };
}

async function verifyPin(pin, pinHash, pinSalt) {
  if (!pinHash || !pinSalt) return false;
  let derived;
  try {
    derived = await scrypt(String(pin), pinSalt, KEYLEN, COST);
  } catch {
    return false;
  }
  const expected = Buffer.from(pinHash, 'hex');
  if (expected.length !== derived.length) return false;
  // Constant-time compare: a byte-by-byte early return leaks how much of the
  // hash matched, which is enough to reconstruct it given enough attempts.
  return crypto.timingSafeEqual(expected, derived);
}

module.exports = { hashPin, verifyPin };
