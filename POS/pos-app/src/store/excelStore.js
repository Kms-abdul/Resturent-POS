'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');

const config = require('../config');
const logger = require('../lib/logger');
const Mutex = require('../lib/mutex');
const money = require('../lib/money');
const { SHEETS, SHEET_ORDER } = require('./schema');
const { unavailable } = require('../lib/errors');

/**
 * ============================================================================
 * The Excel-backed store
 * ============================================================================
 *
 * The requirement is that a plain .xlsx file is the system of record -- the
 * owner wants to open it in Excel and see their data. That is a legitimate
 * requirement, and it is achievable, but only under one hard constraint:
 *
 *     EXACTLY ONE PROCESS MAY EVER WRITE THE WORKBOOK.
 *
 * That process is this server. Tills are browsers; they never touch the file.
 * Every mutation funnels through `mutate()`, which holds a mutex, so there is
 * no interleaving and no lost update even with six tills billing at once.
 *
 * The remaining danger is a crash or power cut partway through rewriting the
 * file. An .xlsx is a zip archive: a partial write is not a partially-correct
 * spreadsheet, it is an unopenable file. So the workbook is never the first
 * thing written. The sequence for every change is:
 *
 *   1. apply the change to the in-memory tables      (fast, authoritative)
 *   2. append the event to journal.jsonl and fsync   (durable, crash-proof)
 *   3. later, rewrite the whole workbook atomically  (human-readable)
 *
 * Step 2 is what makes the system safe: once fsync returns, the sale survives
 * anything short of disk failure. Step 3 is debounced, because rewriting a zip
 * archive on every tap during a dinner rush is wasteful and pointless -- the
 * journal already has the data.
 *
 * On startup we load the workbook and then replay any journal entries that
 * accumulated after the last successful rewrite. So a crash costs, at worst,
 * the freshness of the .xlsx file, never a sale.
 *
 * When Excel has the file open, Windows locks it and the atomic rename fails.
 * We treat that as expected, not as an error: the store enters DEGRADED mode,
 * keeps journalling every sale, keeps serving every till, and retries the
 * rewrite until the file is free again. /health/ready reports it so it is
 * visible rather than silent.
 */

const EMPTY_STATE = () => ({
  menu_items: new Map(),
  orders: new Map(),
  order_items: new Map(),
  users: new Map(),
  settings: new Map(),
});

class ExcelStore {
  constructor() {
    this.state = EMPTY_STATE();
    this.mutex = new Mutex();
    this.seq = 0;

    this.ready = false;
    this.degraded = false;
    this.degradedReason = null;
    this.lastFlushAt = null;
    this.pendingEvents = 0;

    this._flushTimer = null;
    this._flushDeadline = null;
    this._backupTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init() {
    await fsp.mkdir(config.dataDir, { recursive: true });
    await fsp.mkdir(config.backupDir, { recursive: true });

    await this.mutex.run(async () => {
      await this._loadWorkbook();
      const replayed = await this._replayJournal();
      if (replayed > 0) {
        logger.warn(
          { replayed },
          'Replayed journal entries written after the last workbook save. ' +
            'This is normal after an unclean shutdown; no data was lost.'
        );
      }
      this.ready = true;
    });

    // Take a backup of whatever we just loaded, before this session writes
    // anything. If today turns out to be the day something goes wrong, this is
    // the file you restore from.
    await this.backup('startup').catch((err) =>
      logger.error({ err }, 'Startup backup failed (continuing)')
    );

    this._backupTimer = setInterval(() => {
      this.backup('hourly').catch((err) => logger.error({ err }, 'Hourly backup failed'));
    }, 60 * 60 * 1000);
    this._backupTimer.unref?.();

    // If we replayed anything, get the workbook current as soon as possible.
    if (this.pendingEvents > 0) this._scheduleFlush();

    logger.info(
      {
        workbook: config.workbookPath,
        menuItems: this.state.menu_items.size,
        orders: this.state.orders.size,
        users: this.state.users.size,
      },
      'Excel store ready'
    );
  }

  async close() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    if (this._backupTimer) clearInterval(this._backupTimer);
    // Best effort: get the workbook current before we exit so the owner is not
    // looking at a stale sheet tomorrow morning.
    await this.flush({ force: true }).catch((err) =>
      logger.error({ err }, 'Final flush failed; journal retains all data')
    );
  }

  // ---------------------------------------------------------------------------
  // Reads
  //
  // Reads are served from memory and never touch the disk. That is what lets a
  // till render the menu grid instantly instead of unzipping and parsing a
  // spreadsheet on every page load.
  // ---------------------------------------------------------------------------

  all(table) {
    return Array.from(this.state[table].values());
  }

  get(table, id) {
    return this.state[table].get(String(id));
  }

  find(table, predicate) {
    for (const row of this.state[table].values()) {
      if (predicate(row)) return row;
    }
    return undefined;
  }

  filter(table, predicate) {
    return this.all(table).filter(predicate);
  }

  setting(key, fallback = null) {
    const row = this.state.settings.get(String(key));
    return row ? row.value : fallback;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Apply one or more events atomically.
   *
   * `build` receives a read-only view of the store and returns
   * `{ events, result }`. It runs inside the mutex, which is what makes
   * read-then-write logic (allocate the next invoice number, check stock,
   * verify the order exists) safe against concurrent tills. Anything that reads
   * state and then writes based on what it read MUST go through here rather
   * than reading first and calling mutate afterwards.
   */
  async mutate(build) {
    if (!this.ready) throw unavailable('Store is still starting up. Try again in a moment.');

    return this.mutex.run(async () => {
      const built = await build(this);
      const events = (built && built.events) || [];
      if (events.length === 0) return built ? built.result : undefined;

      const stamped = events.map((e) => ({
        seq: ++this.seq,
        ts: new Date().toISOString(),
        type: e.type,
        payload: e.payload,
      }));

      // Apply first so an event that the reducer rejects never reaches the
      // journal -- the journal must only ever contain events we know replay
      // cleanly, otherwise startup breaks and the POS will not boot.
      for (const event of stamped) this._apply(event);

      await this._appendJournal(stamped);
      this.pendingEvents += stamped.length;
      this._scheduleFlush();

      return built.result;
    });
  }

  /**
   * The reducer. Every change to in-memory state happens here and nowhere else.
   *
   * This is the single most important invariant in the file: because startup
   * replay calls exactly this function with exactly these events, the state
   * after a crash-and-restart is identical to the state before the crash. If
   * you ever mutate `this.state` outside `_apply`, that guarantee is gone and
   * the failure will not show up until the next unclean shutdown.
   */
  _apply(event) {
    const { type, payload } = event;

    switch (type) {
      case 'menu.upsert': {
        const row = payload;
        this.state.menu_items.set(String(row.id), { ...row });
        break;
      }
      case 'menu.deactivate': {
        const row = this.state.menu_items.get(String(payload.id));
        // Deactivate rather than delete: an order placed last Tuesday still
        // references this item, and a report that cannot resolve the name of a
        // sold dish is a broken report.
        if (row) {
          row.isActive = false;
          row.updatedAt = payload.updatedAt;
        }
        break;
      }
      case 'order.create': {
        this.state.orders.set(String(payload.order.id), { ...payload.order });
        for (const line of payload.items) {
          this.state.order_items.set(String(line.lineId), { ...line });
        }
        break;
      }
      case 'order.void': {
        const order = this.state.orders.get(String(payload.id));
        if (order) {
          order.status = 'voided';
          order.voidedAt = payload.voidedAt;
          order.voidReason = payload.voidReason;
        }
        break;
      }
      case 'order.fulfill': {
        const order = this.state.orders.get(String(payload.id));
        if (order) {
          order.fulfillmentStatus = payload.fulfillmentStatus;
        }
        break;
      }
      case 'user.upsert': {
        this.state.users.set(String(payload.id), { ...payload });
        break;
      }
      case 'setting.set': {
        this.state.settings.set(String(payload.key), {
          key: payload.key,
          value: String(payload.value),
          updatedAt: payload.updatedAt,
        });
        break;
      }
      default:
        // Unknown event types are a hard failure rather than a skip. Silently
        // ignoring one during replay would mean booting with a state that
        // quietly differs from what was actually recorded.
        throw new Error(`Unknown event type in journal: ${type}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Journal
  // ---------------------------------------------------------------------------

  async _appendJournal(events) {
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const handle = await fsp.open(config.journalPath, 'a');
    try {
      await handle.write(lines, null, 'utf8');
      // fsync is the whole point. Without it the write sits in the OS page
      // cache and a power cut loses it -- which on a POS means a customer paid
      // and the sale does not exist.
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async _replayJournal() {
    if (!fs.existsSync(config.journalPath)) return 0;
    const text = await fsp.readFile(config.journalPath, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    let count = 0;

    for (const [i, line] of lines.entries()) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // A torn final line is the expected shape of a crash mid-append. Any
        // other position is corruption and we must not guess.
        if (i === lines.length - 1) {
          logger.warn('Discarding incomplete final journal line (crash during write)');
          break;
        }
        throw new Error(`Journal corrupt at line ${i + 1}. Restore from ${config.backupDir}`);
      }
      this._apply(event);
      if (event.seq > this.seq) this.seq = event.seq;
      count += 1;
    }

    this.pendingEvents += count;
    return count;
  }

  // ---------------------------------------------------------------------------
  // Workbook read/write
  // ---------------------------------------------------------------------------

  async _loadWorkbook() {
    if (!fs.existsSync(config.workbookPath)) {
      logger.info({ path: config.workbookPath }, 'No workbook found; starting with empty tables');
      return;
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(config.workbookPath);

    for (const table of SHEET_ORDER) {
      const def = SHEETS[table];
      const sheet = wb.getWorksheet(def.name);
      if (!sheet) continue;

      // Map by header text rather than by column position. Users reorder and
      // insert columns in Excel; positional parsing turns that harmless edit
      // into silently scrambled data.
      const headerRow = sheet.getRow(1);
      const indexByHeader = new Map();
      headerRow.eachCell((cell, colNumber) => {
        indexByHeader.set(String(cell.value ?? '').trim(), colNumber);
      });

      for (let r = 2; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        const obj = {};
        let hasAnyValue = false;

        for (const col of def.columns) {
          const colNumber = indexByHeader.get(col.header);
          const raw = colNumber ? row.getCell(colNumber).value : null;
          const parsed = parseCell(raw, col.type);
          obj[col.key] = parsed;
          if (parsed !== null && parsed !== undefined && parsed !== '') hasAnyValue = true;
        }

        // Excel files routinely carry thousands of formatted-but-empty trailing
        // rows. Importing them as blank records would corrupt every count.
        if (!hasAnyValue) continue;

        const id = obj[def.idKey];
        if (id === null || id === undefined || id === '') continue;
        this.state[table].set(String(id), obj);
      }
    }

    const storedSeq = Number.parseInt(this.setting('journal_seq', '0'), 10);
    if (Number.isFinite(storedSeq)) this.seq = storedSeq;
  }

  _scheduleFlush() {
    if (this._flushTimer) clearTimeout(this._flushTimer);

    const now = Date.now();
    if (!this._flushDeadline) this._flushDeadline = now + config.flushMaxWaitMs;

    // Debounce, but never longer than flushMaxWaitMs. Under continuous load a
    // pure debounce never fires, and the owner's spreadsheet would stay stale
    // for the entire service.
    const delay = Math.max(0, Math.min(config.flushDebounceMs, this._flushDeadline - now));

    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushDeadline = null;
      this.flush().catch((err) => logger.error({ err }, 'Scheduled flush failed'));
    }, delay);
    this._flushTimer.unref?.();
  }

  /**
   * Rewrite the workbook atomically, then clear the journal.
   *
   * Runs inside the mutex, so no events can arrive mid-write. That is what lets
   * us truncate the journal unconditionally on success: at the moment of
   * truncation the workbook provably contains every event the journal held.
   */
  async flush({ force = false } = {}) {
    if (!this.ready && !force) return;
    if (this.pendingEvents === 0 && !force) return;

    return this.mutex.run(async () => {
      const tmpPath = path.join(
        config.dataDir,
        `.tmp-${process.pid}-${Date.now()}-${path.basename(config.workbookPath)}`
      );

      try {
        // Record the sequence number inside the workbook so a restore from this
        // file alone knows where the journal left off.
        this.state.settings.set('journal_seq', {
          key: 'journal_seq',
          value: String(this.seq),
          updatedAt: new Date().toISOString(),
        });

        const wb = this._buildWorkbook();
        await wb.xlsx.writeFile(tmpPath);

        // fsync the temp file before renaming. A rename is atomic with respect
        // to the directory entry, but that guarantees nothing about the file's
        // contents having reached the platter.
        const handle = await fsp.open(tmpPath, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }

        // Atomic replace. Either the old workbook or the new one is present at
        // this path -- never a half-written zip.
        await fsp.rename(tmpPath, config.workbookPath);

        await fsp.writeFile(config.journalPath, '', 'utf8');
        this.pendingEvents = 0;
        this.lastFlushAt = new Date().toISOString();

        if (this.degraded) {
          logger.info('Workbook writable again; leaving degraded mode');
          this.degraded = false;
          this.degradedReason = null;
        }
      } catch (err) {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});

        // EBUSY/EPERM/EACCES on Windows almost always means someone has the
        // workbook open in Excel. This is a routine operational event in a
        // restaurant, not a bug, and it must not stop anyone from billing.
        const locked = ['EBUSY', 'EPERM', 'EACCES'].includes(err.code);
        this.degraded = true;
        this.degradedReason = locked
          ? 'The workbook is open in Excel or locked by another program. Sales are still being ' +
            'recorded safely in the journal and will be written to the file once it is closed.'
          : `Could not write the workbook: ${err.message}`;

        logger[locked ? 'warn' : 'error'](
          { err, code: err.code },
          'Workbook write failed; running in journal-only mode'
        );

        // Retry on the normal cadence. The journal keeps growing meanwhile,
        // which is exactly what it is for.
        setTimeout(() => this._scheduleFlush(), 10_000).unref?.();
      }
    });
  }

  _buildWorkbook() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Restaurant POS';
    wb.created = new Date();

    for (const table of SHEET_ORDER) {
      const def = SHEETS[table];
      const sheet = wb.addWorksheet(def.name, {
        views: [{ state: 'frozen', ySplit: 1 }],
      });

      sheet.columns = def.columns.map((c) => ({
        header: c.header,
        key: c.key,
        width: c.width || 16,
      }));

      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E293B' },
      };
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFD700' } };

      for (const row of this.state[table].values()) {
        const out = {};
        for (const col of def.columns) out[col.key] = serializeCell(row[col.key], col.type);
        sheet.addRow(out);
      }

      // Number formats applied per column so the sheet is readable and sortable
      // by a human, not just parseable by us.
      def.columns.forEach((col, i) => {
        const column = sheet.getColumn(i + 1);
        if (col.type === 'money') column.numFmt = '#,##0.00';
        if (col.type === 'datetime') column.numFmt = 'yyyy-mm-dd hh:mm:ss';
      });

      if (sheet.rowCount > 1) {
        sheet.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: 1, column: def.columns.length },
        };
      }
    }

    return wb;
  }

  // ---------------------------------------------------------------------------
  // Backups
  // ---------------------------------------------------------------------------

  async backup(reason = 'manual') {
    if (!fs.existsSync(config.workbookPath)) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(config.backupDir, `pos-data-${stamp}-${reason}.xlsx`);
    await fsp.copyFile(config.workbookPath, dest);

    // Prune oldest beyond the retention count. Unbounded backups fill the disk,
    // and a full disk stops the POS from taking orders at all.
    const files = (await fsp.readdir(config.backupDir))
      .filter((f) => f.startsWith('pos-data-') && f.endsWith('.xlsx'))
      .sort();
    const excess = files.length - config.backupKeep;
    for (let i = 0; i < excess; i += 1) {
      await fsp.rm(path.join(config.backupDir, files[i]), { force: true }).catch(() => {});
    }

    logger.info({ dest, reason }, 'Backup written');
    return dest;
  }

  health() {
    return {
      ready: this.ready,
      degraded: this.degraded,
      degradedReason: this.degradedReason,
      pendingEvents: this.pendingEvents,
      queueDepth: this.mutex.queueDepth,
      lastFlushAt: this.lastFlushAt,
      seq: this.seq,
      counts: {
        menuItems: this.state.menu_items.size,
        orders: this.state.orders.size,
        orderItems: this.state.order_items.size,
        users: this.state.users.size,
      },
    };
  }
}

// -----------------------------------------------------------------------------
// Cell conversion
//
// Excel's type coercion is the single largest source of bugs in spreadsheet-
// backed systems. These two functions are where we refuse to let it happen:
// every value is converted explicitly on the way in and on the way out, and
// nothing is left to inference.
// -----------------------------------------------------------------------------

function parseCell(raw, type) {
  // ExcelJS returns rich-text objects, hyperlink objects, and formula results
  // as wrapped values. Unwrap before doing anything else.
  let v = raw;
  if (v && typeof v === 'object') {
    if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if ('result' in v) v = v.result;
    else if ('text' in v) v = v.text;
    else if (v instanceof Date) v = v;
  }
  if (v === null || v === undefined || v === '') {
    return type === 'bool' ? false : null;
  }

  switch (type) {
    case 'int': {
      const n = Number.parseInt(String(v).replace(/[^0-9\-]/g, ''), 10);
      return Number.isFinite(n) ? n : null;
    }
    case 'float': {
      const n = Number.parseFloat(String(v).replace(/[^0-9\.\-]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'money': {
      // Stored in the sheet as rupees for human readability; held in memory as
      // integer paise so arithmetic is exact.
      try {
        return money.toMinor(typeof v === 'number' ? v : String(v));
      } catch {
        return null;
      }
    }
    case 'bool': {
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      return ['true', 'yes', 'y', '1', 'active'].includes(s);
    }
    case 'datetime': {
      if (v instanceof Date) return v.toISOString();
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    case 'text':
    default:
      // Deliberately String(): identifiers like table numbers and SKUs must not
      // be allowed to become numbers, or "007" silently becomes 7.
      return String(v).trim();
  }
}

function serializeCell(value, type) {
  if (value === null || value === undefined) return type === 'bool' ? false : null;
  switch (type) {
    case 'money':
      return money.toMajor(value);
    case 'datetime':
      return value instanceof Date ? value : new Date(value);
    case 'bool':
      return Boolean(value);
    case 'int':
    case 'float':
      return Number(value);
    case 'text':
    default:
      return sanitizeForExcel(String(value));
  }
}

/**
 * CSV/formula injection guard.
 *
 * A cell whose text begins with =, +, - or @ is executed as a formula when the
 * file is opened. Item names come from a form, so an item called
 * `=HYPERLINK("http://evil","Click")` would become a live link in the owner's
 * spreadsheet. Prefixing with an apostrophe forces Excel to treat it as text.
 */
function sanitizeForExcel(s) {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

module.exports = new ExcelStore();
module.exports.ExcelStore = ExcelStore;
