'use strict';

/**
 * Prepares .env on first run.
 *
 * The reason this is a script rather than a line in the README: the step it
 * automates -- generating a signing secret and pasting it into a config file --
 * is exactly the step people skip or fumble, and the failure mode is a system
 * that runs fine while being trivially forgeable. Making the safe path the
 * automatic one is worth more than any warning in a document.
 *
 * Safe to run repeatedly. It never overwrites a secret that has already been set.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const EXAMPLE = path.join(ROOT, '.env.example');

function main() {
  if (!fs.existsSync(EXAMPLE)) {
    console.error('.env.example is missing. Re-download the application folder.');
    process.exit(1);
  }

  if (!fs.existsSync(ENV)) {
    fs.copyFileSync(EXAMPLE, ENV);
    console.log('Created .env from .env.example');
  } else {
    console.log('.env already exists, leaving it alone');
  }

  let text = fs.readFileSync(ENV, 'utf8');

  if (/^JWT_SECRET=CHANGE_ME/m.test(text)) {
    const secret = crypto.randomBytes(48).toString('hex');
    text = text.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`);
    fs.writeFileSync(ENV, text, 'utf8');
    console.log('Generated a signing secret and wrote it to .env');
  } else {
    console.log('Signing secret already set, leaving it alone');
  }

  console.log('\nConfiguration ready.');
}

main();
