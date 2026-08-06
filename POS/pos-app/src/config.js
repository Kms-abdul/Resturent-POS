'use strict';

/**
 * Configuration is read once, validated once, at startup.
 *
 * The reason this file throws rather than falling back to defaults for the
 * security-relevant values: a POS that silently boots with a default signing
 * secret is a POS where any till can forge a manager token. Failing loudly at
 * 9am when someone is setting up is enormously cheaper than failing quietly at
 * 9pm on a Saturday.
 */

const path = require('path');
const fs = require('fs');

// Minimal .env loader. Avoids a dependency for something this small, and keeps
// behaviour obvious: real environment variables always win over the file.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

const problems = [];

function str(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) {
      problems.push(`${name} is required but not set`);
      return '';
    }
    return fallback;
  }
  return v;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    problems.push(`${name} must be a whole number, got "${raw}"`);
    return fallback;
  }
  return n;
}

const jwtSecret = str('JWT_SECRET');
if (jwtSecret && jwtSecret.startsWith('CHANGE_ME')) {
  problems.push(
    'JWT_SECRET is still the placeholder from .env.example. Generate a real one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
  );
}
if (jwtSecret && jwtSecret.length < 32 && !jwtSecret.startsWith('CHANGE_ME')) {
  problems.push('JWT_SECRET must be at least 32 characters');
}

const dataDir = path.resolve(ROOT, str('DATA_DIR', './data'));

const config = {
  root: ROOT,
  env: str('NODE_ENV', 'production'),
  port: int('PORT', 4000),
  host: str('HOST', '0.0.0.0'),
  logLevel: str('LOG_LEVEL', 'info'),

  jwtSecret,
  sessionTtl: str('SESSION_TTL', '12h'),

  dataDir,
  workbookPath: path.join(dataDir, str('WORKBOOK', 'pos-data.xlsx')),
  journalPath: path.join(dataDir, 'journal.jsonl'),
  backupDir: path.join(dataDir, 'backups'),
  certDir: path.join(dataDir, 'certs'),

  flushDebounceMs: int('FLUSH_DEBOUNCE_MS', 2000),
  flushMaxWaitMs: int('FLUSH_MAX_WAIT_MS', 15000),
  backupKeep: int('BACKUP_KEEP', 30),

  currencySymbol: str('CURRENCY_SYMBOL', '₹'),
};

if (problems.length) {
  // eslint-disable-next-line no-console
  console.error(
    '\nPOS cannot start. Fix the configuration in .env:\n\n' +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\n\nSee .env.example for the full list of settings.\n'
  );
  process.exit(1);
}

module.exports = config;
