'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const selfsigned = require('selfsigned');
const logger = require('./logger');

/**
 * ============================================================================
 * Local HTTPS for the till LAN
 * ============================================================================
 *
 * The problem this solves: modern Chrome and Edge treat `http://` as
 * untrustworthy for anything except `localhost`. On a raw LAN address like
 * `http://10.50.217.197:4000`, they silently try to upgrade every request to
 * `https://`, that fails because nothing is listening there, and the failure
 * cascades into broken scripts, blocked form submissions, and -- worst of all
 * -- a login form falling back to a plain GET that puts a PIN in the address
 * bar in plain text. This is not a quirk of one browser or one phone; it is
 * the default posture of every current mobile and desktop browser, and it
 * cannot be fixed by a server that only speaks plain HTTP.
 *
 * The fix is to actually speak HTTPS. Since this is a private LAN with no
 * public domain name, there is no certificate authority that will issue a
 * "real" certificate for it -- so the server generates and manages its own
 * self-signed one. Every device will show a one-time "connection is not
 * private" warning the first time it visits, which is expected and correct
 * for a self-signed certificate; accepting it once is enough, and the browser
 * remembers the choice for that device from then on. Devices that want the
 * warning gone entirely can install the certificate as trusted -- see the
 * README -- but it is not required for the app to work.
 *
 * The certificate is regenerated automatically, with no action needed, when:
 *   - it does not exist yet (first run)
 *   - the server's LAN IP addresses have changed (new router, DHCP renewal)
 *   - it is within 30 days of expiring
 *
 * Validity is capped at 397 days deliberately: Apple's platforms (Safari,
 * iOS) refuse to trust TLS certificates valid for longer than 398 days, even
 * ones a user has manually marked as trusted. Going over that silently breaks
 * every iPhone and iPad till, which is exactly the failure mode this file
 * exists to prevent.
 */

const MAX_VALID_DAYS = 397;
const RENEW_WITHIN_DAYS = 30;

/** Every address a device on this LAN might use to reach this server. */
function currentHosts() {
  const hosts = new Set(['localhost', '127.0.0.1']);
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal) hosts.add(iface.address);
  }
  return Array.from(hosts).sort();
}

function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function isStillValid(meta, hosts) {
  if (!meta || !Array.isArray(meta.hosts) || !meta.expiresAt) return false;

  const sameHosts =
    meta.hosts.length === hosts.length && meta.hosts.every((h, i) => h === hosts[i]);
  if (!sameHosts) return false;

  const renewBy = new Date(meta.expiresAt).getTime() - RENEW_WITHIN_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() < renewBy;
}

function generate(hosts) {
  const altNames = hosts.map((h) =>
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? { type: 7, ip: h } : { type: 2, value: h }
  );

  const pems = selfsigned.generate([{ name: 'commonName', value: 'restaurant-pos.local' }], {
    days: MAX_VALID_DAYS,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        keyEncipherment: true,
        nonRepudiation: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  return {
    key: pems.private,
    cert: pems.cert,
    expiresAt: new Date(Date.now() + MAX_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Returns { key, cert, certPath } ready to hand to `https.createServer`.
 * Generates or regenerates the certificate on disk as needed; safe to call on
 * every startup.
 */
function ensureCert(certDir) {
  fs.mkdirSync(certDir, { recursive: true });

  const keyPath = path.join(certDir, 'server.key');
  const certPath = path.join(certDir, 'server.crt');
  const metaPath = path.join(certDir, 'meta.json');

  const hosts = currentHosts();
  const meta = readMeta(metaPath);
  const filesPresent = fs.existsSync(keyPath) && fs.existsSync(certPath);

  if (!filesPresent || !isStillValid(meta, hosts)) {
    logger.info(
      { hosts, reason: filesPresent ? 'renewal or LAN address change' : 'first run' },
      'Generating local HTTPS certificate'
    );

    const { key, cert, expiresAt } = generate(hosts);
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    fs.writeFileSync(certPath, cert);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ hosts, generatedAt: new Date().toISOString(), expiresAt }, null, 2)
    );

    logger.info(
      { expiresAt },
      'Certificate ready. Every device will show a one-time "connection is not private" ' +
        'warning on first visit -- that is expected for a self-signed certificate. See the ' +
        'README for how to accept it, and how to install it as fully trusted if preferred.'
    );
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    certPath,
  };
}

module.exports = { ensureCert, currentHosts };
