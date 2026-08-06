'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const store = require('./store/excelStore');
const config = require('./config');
const {
  requestId,
  requestLogger,
  notFoundHandler,
  errorHandler,
} = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  // Tills reach the server by IP over the shop LAN, so req.ip must reflect the
  // actual till for the rate limiter and the audit log to mean anything.
  app.set('trust proxy', false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The UI is a single self-contained HTML file with inline styles, so
          // style-src needs 'unsafe-inline'. Scripts do not: all JS lives in
          // /app.js, which is what actually matters for XSS.
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      // HSTS is deliberately off, even though every connection here is TLS.
      // The certificate is self-signed, so every device's *first* visit shows
      // a "connection is not private" warning with an "Advanced -> Proceed"
      // escape hatch -- that click-through is what makes a self-signed
      // certificate usable at all. HSTS removes exactly that escape hatch:
      // Chrome refuses to let a user bypass a certificate warning on a host
      // it has previously seen send an HSTS header. Turning this on would
      // mean any hiccup around the certificate (clock skew on a phone, a
      // renewal after an IP change) permanently locks that device out with no
      // way to click through, until the HSTS record itself expires.
      hsts: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(requestId);
  // Bounded body size. An unbounded parser is a trivial way to exhaust memory
  // on the one machine every till depends on.
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(requestLogger);

  // Broad limiter as a backstop. Auth has its own, much tighter one.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    })
  );

  // Liveness: is the process up? Readiness: can it actually serve orders?
  // Orchestrators and the till UI need to distinguish these; "up but not
  // ready" is a real and important state during startup and journal replay.
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', (_req, res) => {
    const health = store.health();
    // Degraded means the workbook is locked but sales are still journalling
    // safely, so it is 200 with a warning, not a failure. Marking it unhealthy
    // would take the POS offline for something that does not lose data.
    res.status(health.ready ? 200 : 503).json({
      status: health.ready ? (health.degraded ? 'degraded' : 'ok') : 'starting',
      ...health,
    });
  });

  // Public by design: a certificate is not a secret (only the private key
  // is, and that never leaves the server). Serving it here lets a device
  // install it as a trusted root -- Settings -> install/trust the downloaded
  // profile -- for staff who want the "connection is not private" warning
  // gone entirely instead of clicking through it once. Optional; the app
  // works fine without this step.
  app.get('/cert', (_req, res) => {
    res.set('Content-Type', 'application/x-x509-ca-cert');
    res.set('Content-Disposition', 'attachment; filename="restaurant-pos.crt"');
    res.sendFile(path.join(config.certDir, 'server.crt'));
  });

  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/menu', require('./routes/menu.routes'));
  app.use('/api/orders', require('./routes/orders.routes'));
  app.use('/api/users', require('./routes/users.routes'));
  app.use('/api/reports', require('./routes/reports.routes'));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
