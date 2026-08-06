'use strict';

const express = require('express');
const { z } = require('zod');

const store = require('../store/excelStore');
const { hashPin } = require('../lib/pin');
const { ROLES } = require('../store/schema');
const { authenticate, require: requirePerm } = require('../middleware/auth');
const { notFound, conflict, badRequest } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

const pinSchema = z.string().trim().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits');

const createUserInput = z.object({
  name: z.string().trim().min(1).max(40),
  role: z.enum([ROLES.CASHIER, ROLES.MANAGER]),
  pin: pinSchema,
});

function toApi(u) {
  // pin, pinHash and pinSalt are never serialised over the API, even to a
  // manager. The PIN is stored in plain text in the workbook at the owner's
  // request so a forgotten PIN can be recovered by opening the file -- but
  // that is a deliberately smaller exposure (whoever can open pos-data.xlsx)
  // than putting it on the network (every device that can call this endpoint).
  // Keep those two exposures separate.
  return { id: u.id, name: u.name, role: u.role, isActive: u.isActive, createdAt: u.createdAt };
}

router.get('/', requirePerm('users:manage'), (req, res, next) => {
  try {
    res.json({ users: store.all('users').map(toApi) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requirePerm('users:manage'), async (req, res, next) => {
  try {
    const data = createUserInput.parse(req.body);
    const { pinHash, pinSalt } = await hashPin(data.pin);

    const user = await store.mutate((s) => {
      const clash = s.find(
        'users',
        (u) => u.isActive && String(u.name).toLowerCase() === data.name.toLowerCase()
      );
      if (clash) throw conflict(`A staff member named "${data.name}" already exists.`);

      const id = s.all('users').reduce((max, u) => Math.max(max, Number(u.id) || 0), 0) + 1;
      const row = {
        id,
        name: data.name,
        role: data.role,
        pin: data.pin,
        pinHash,
        pinSalt,
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      return { events: [{ type: 'user.upsert', payload: row }], result: toApi(row) };
    });

    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

/**
 * Anyone may change their own PIN; a manager may reset someone else's.
 *
 * Changing your own requires the current PIN, so a till left unlocked while the
 * cashier is on break cannot be used to silently lock them out of their own
 * account.
 */
router.post('/:id/pin', async (req, res, next) => {
  try {
    const targetId = String(req.params.id);
    const isSelf = targetId === String(req.user.id);
    const isManager = req.user.role === ROLES.MANAGER;
    if (!isSelf && !isManager) throw badRequest('You can only change your own PIN.');

    const body = z
      .object({ newPin: pinSchema, currentPin: pinSchema.optional() })
      .parse(req.body);

    const target = store.get('users', targetId);
    if (!target || !target.isActive) throw notFound('That staff member does not exist.');

    if (isSelf) {
      const { verifyPin } = require('../lib/pin');
      const ok =
        body.currentPin && (await verifyPin(body.currentPin, target.pinHash, target.pinSalt));
      if (!ok) throw badRequest('Your current PIN is not right.');
    }

    const { pinHash, pinSalt } = await hashPin(body.newPin);
    await store.mutate((s) => {
      const row = { ...s.get('users', targetId), pin: body.newPin, pinHash, pinSalt };
      return { events: [{ type: 'user.upsert', payload: row }], result: null };
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requirePerm('users:manage'), async (req, res, next) => {
  try {
    const targetId = String(req.params.id);
    if (targetId === String(req.user.id)) {
      throw conflict('You cannot deactivate your own account while signed in.');
    }

    const user = await store.mutate((s) => {
      const existing = s.get('users', targetId);
      if (!existing) throw notFound('That staff member does not exist.');

      // Refuse to remove the last manager. Locking every manager out of the
      // system leaves nobody able to add menu items or run reports, and the
      // only fix is editing the spreadsheet by hand.
      const otherManagers = s.filter(
        'users',
        (u) => u.isActive && u.role === ROLES.MANAGER && String(u.id) !== targetId
      );
      if (existing.role === ROLES.MANAGER && otherManagers.length === 0) {
        throw conflict('This is the only manager. Add another before removing this one.');
      }

      const row = { ...existing, isActive: false };
      return { events: [{ type: 'user.upsert', payload: row }], result: toApi(row) };
    });

    res.json({ user });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
