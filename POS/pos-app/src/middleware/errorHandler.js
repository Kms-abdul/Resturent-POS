'use strict';

const crypto = require('crypto');
const { ZodError } = require('zod');
const logger = require('../lib/logger');
const { AppError } = require('../lib/errors');

/** Attach a correlation id to every request so a user's "it broke" maps to a log line. */
function requestId(req, res, next) {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  res.set('x-request-id', req.id);
  next();
}

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info(
      {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(ms),
        user: req.user ? req.user.name : null,
      },
      'request'
    );
  });
  next();
}

function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  // Validation failures are the user's problem to fix, so they get specifics.
  if (err instanceof ZodError) {
    const details = err.errors.map((e) => ({
      field: e.path.join('.') || '(root)',
      message: e.message,
    }));
    return res.status(400).json({
      error: { code: 'VALIDATION_FAILED', message: 'Check the highlighted fields.', details, requestId: req.id },
    });
  }

  if (err instanceof AppError) {
    logger.warn({ requestId: req.id, code: err.code, msg: err.message }, 'handled error');
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId: req.id },
    });
  }

  // Anything else is a bug. Log the stack for us; tell the user nothing about
  // the internals, because stack traces and driver messages are a map of the
  // system for anyone probing it.
  logger.error({ requestId: req.id, err }, 'unhandled error');
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Nothing was saved.',
      requestId: req.id,
    },
  });
}

module.exports = { requestId, requestLogger, notFoundHandler, errorHandler };
