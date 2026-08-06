'use strict';

/**
 * Manual backup. Also the thing to schedule in Windows Task Scheduler if you
 * want a copy taken at close of business.
 *
 * Worth saying plainly: a backup you have never restored is a hypothesis, not a
 * backup. Once a month, copy a file out of data/backups, rename it over
 * data/pos-data.xlsx on a spare machine, delete the journal, and start the
 * server. If it comes up with the right numbers, your backups work.
 */

const store = require('../src/store/excelStore');

async function main() {
  await store.init();
  await store.flush({ force: true });
  const dest = await store.backup('manual');
  console.log(dest ? `Backup written to ${dest}` : 'Nothing to back up yet.');
  await store.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Backup failed:', err);
  process.exit(1);
});
