'use strict';

const pino = require('pino');
const config = require('../config');

/**
 * Structured JSON logs with a redaction filter applied at the logger, not at
 * each call site. Relying on every developer to remember not to log a PIN is a
 * plan that works until the one time it doesn't, and log files tend to outlive
 * the incident that made you check them.
 */
const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'pin',
      'password',
      'token',
      '*.pin',
      '*.password',
      '*.token',
      'req.headers.authorization',
      'req.headers.cookie',
      'body.pin',
      'body.password',
    ],
    censor: '[redacted]',
  },
  base: { service: 'restaurant-pos' },
});

module.exports = logger;
