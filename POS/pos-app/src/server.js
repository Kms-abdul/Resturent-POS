'use strict';

const os = require('os');
const https = require('https');
const config = require('./config');
const logger = require('./lib/logger');
const store = require('./store/excelStore');
const createApp = require('./app');
const { ensureCert } = require('./lib/certs');

/**
 * Startup order matters: the store must be loaded and the journal replayed
 * before the first request is accepted. Serving traffic against a half-loaded
 * menu would let a till place an order referencing an item that has not been
 * read yet, and the order would be rejected for no reason the cashier can
 * understand.
 *
 * The server speaks HTTPS only, using a self-signed certificate it manages
 * itself (see lib/certs.js). Plain HTTP is not offered as a fallback: mixing
 * the two is what caused the original failure this exists to fix -- a browser
 * silently attempting to upgrade an http:// LAN address to https://, finding
 * nothing there, and falling back to unsafe behaviour (a login form posting
 * a PIN as a plain-text URL parameter). One protocol, always on, is simpler
 * and safer than a fallback that only exists to be silently defeated.
 */
async function main() {
  await store.init();

  const app = createApp();
  const { key, cert, certPath } = ensureCert(config.certDir);
  const server = https.createServer({ key, cert }, app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const addresses = [];
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal) {
      addresses.push(`https://${iface.address}:${config.port}`);
    }
  }
  logger.info(
    { local: `https://localhost:${config.port}`, lan: addresses, certificate: certPath },
    'POS server listening. Open one of the LAN addresses on each till. Each device shows a ' +
      'one-time "connection is not private" warning on first visit -- that is expected for a ' +
      'self-signed certificate. Accept it once; see the README for details.'
  );

  // Slow clients must not hold sockets open indefinitely on the one machine
  // the whole restaurant depends on.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  /**
   * Graceful shutdown. Stop accepting new work, let in-flight requests finish,
   * then force one final workbook write so the owner is not looking at a stale
   * spreadsheet tomorrow. The journal already holds everything, so even a hard
   * kill here is safe -- this is about convenience, not correctness.
   */
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 15_000);
    force.unref();

    server.close(async () => {
      try {
        await store.close();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crashed process that keeps running in an unknown state is more dangerous
  // than one that exits: it can serve wrong prices. Log, flush, die, restart.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    store.close().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    store.close().finally(() => process.exit(1));
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
