'use strict';

const express = require('express');
const orderService = require('../services/order.service');
const { authenticate, require: requirePerm } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

/**
 * Reserve the next auto token. Called when a till starts an order, so the
 * number is on screen before the cashier needs to read it out. Allocation is
 * inside the store lock, so two tills starting at the same instant get
 * different numbers.
 */
router.post('/number', requirePerm('orders:create'), async (req, res, next) => {
  try {
    res.json(await orderService.reserveOrderNumber());
  } catch (err) {
    next(err);
  }
});

router.post('/', requirePerm('orders:create'), async (req, res, next) => {
  try {
    const { order, duplicate } = await orderService.create(
      { ...req.body, clientRef: req.get('idempotency-key') || req.body.clientRef },
      req.user
    );
    // 200 rather than 201 on a replay, so the till can tell "your order was
    // already recorded" apart from "a second order was just created".
    res.status(duplicate ? 200 : 201).json({ order, duplicate });
  } catch (err) {
    next(err);
  }
});

router.get('/', requirePerm('orders:read'), (req, res, next) => {
  try {
    res.json({ orders: orderService.listForDay(req.query.date) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requirePerm('orders:read'), (req, res, next) => {
  try {
    res.json({ order: orderService.get(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/void', requirePerm('orders:void'), async (req, res, next) => {
  try {
    res.json({ order: await orderService.voidOrder(req.params.id, req.body.reason, req.user) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/fulfill', requirePerm('orders:create'), async (req, res, next) => {
  try {
    res.json({ order: await orderService.markFulfilled(req.params.id, req.user) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

