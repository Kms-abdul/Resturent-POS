'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const store = require('../store/excelStore');
const { verifyPin } = require('../lib/pin');
const { signToken, authenticate } = require('../middleware/auth');
const { unauthorized } = require('../lib/errors');
const config = require('../config');
const logger = require('../lib/logger');

const router = express.Router();

/**
 * A 4-digit PIN has only 10,000 possibilities, so the hash is not what protects
 * it -- this limiter is. Without it, an attacker on the shop wifi walks the
 * entire keyspace in under a minute. With it, they get 10 tries per 15 minutes
 * per address, which makes the attack take months and makes it loud in the logs.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many sign-in attempts. Wait 15 minutes or ask a manager.',
    },
  },
});

const loginInput = z.object({
  name: z.string().trim().min(1).max(40),
  pin: z.string().trim().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits'),
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { name, pin } = loginInput.parse(req.body);

    const user = store.find(
      'users',
      (u) => u.isActive && String(u.name).toLowerCase() === name.toLowerCase()
    );

    // Verify against a dummy hash even when the user does not exist, so the
    // response takes the same time either way. A fast "no such user" versus a
    // slow "wrong PIN" tells an attacker which staff names are real, which is
    // half the work of guessing a 4-digit PIN.
    const ok = user
      ? await verifyPin(pin, user.pinHash, user.pinSalt)
      : await verifyPin(pin, '00'.repeat(32), 'decoy');

    if (!user || !ok) {
      logger.warn({ requestId: req.id, name, ip: req.ip }, 'failed sign-in');
      throw unauthorized('That name or PIN is not right.');
    }

    const token = signToken(user);
    res.cookie('pos_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      // `secure` requires HTTPS. On a shop LAN over plain http this would stop
      // the cookie being set at all, so it follows the environment.
      secure: config.env === 'production' && req.secure,
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
    });

    logger.info({ requestId: req.id, user: user.name, role: user.role }, 'sign-in');
    res.json({ user: { id: user.id, name: user.name, role: user.role } });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('pos_token', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
