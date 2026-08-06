'use strict';

const express = require('express');
const menuService = require('../services/menu.service');
const { authenticate, require: requirePerm } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/', requirePerm('menu:read'), (req, res, next) => {
  try {
    const includeInactive =
      req.query.includeInactive === 'true' && req.user.role === 'manager';
    res.json({ items: menuService.list({ includeInactive }) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requirePerm('menu:write'), async (req, res, next) => {
  try {
    res.status(201).json({ item: await menuService.create(req.body) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requirePerm('menu:write'), async (req, res, next) => {
  try {
    res.json({ item: await menuService.update(req.params.id, req.body) });
  } catch (err) {
    next(err);
  }
});

// DELETE deactivates. See menu.service for why history must survive.
router.delete('/:id', requirePerm('menu:write'), async (req, res, next) => {
  try {
    res.json({ item: await menuService.deactivate(req.params.id) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
