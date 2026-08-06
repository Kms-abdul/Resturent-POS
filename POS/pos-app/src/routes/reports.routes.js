'use strict';

const express = require('express');
const reportService = require('../services/report.service');
const store = require('../store/excelStore');
const { authenticate, require: requirePerm } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/daily', requirePerm('orders:read'), (req, res, next) => {
  try {
    res.json({ summary: reportService.dailySummary(req.query.date) });
  } catch (err) {
    next(err);
  }
});

router.get('/daily.xlsx', requirePerm('data:export'), async (req, res, next) => {
  try {
    const { workbook, filename } = await reportService.exportDayWorkbook(req.query.date);
    res.set(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    // Filename is server-generated from a validated date, never echoed from
    // user input -- a reflected filename is a header-injection vector.
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

/** Force the workbook current on demand, e.g. before the owner opens it. */
router.post('/flush', requirePerm('data:export'), async (req, res, next) => {
  try {
    await store.flush({ force: true });
    res.json({ ok: !store.degraded, health: store.health() });
  } catch (err) {
    next(err);
  }
});

router.post('/backup', requirePerm('data:export'), async (req, res, next) => {
  try {
    const path = await store.backup('manual');
    res.json({ ok: true, path });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
