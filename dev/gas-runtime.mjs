// Minimal in-memory stand-in for the Google Apps Script services the portal uses.
// It lets the server code in apps-script/ run under Node for tests and local preview.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPT_DIR = path.join(ROOT, 'apps-script');

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return target[prop];
        // Formatting calls (setFontWeight, setNumberFormat, ...) are no-ops.
        return () => target;
      }
    });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = this.sheet.data[this.row - 1 + r]?.[this.col - 1 + c];
        row.push(v === undefined || v === null ? '' : v instanceof Date ? this.sheet.makeDate(v) : v);
      }
      out.push(row);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    if (values.length !== this.numRows || values.some((r) => r.length !== this.numCols)) {
      throw new Error(`setValues: data has ${values.length}x${values[0]?.length} but range is ${this.numRows}x${this.numCols}`);
    }
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.set(this.row + i, this.col + j, v)));
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
}

class MockSheet {
  constructor(name, makeDate) { this.name = name; this.data = []; this.makeDate = makeDate; }
  getName() { return this.name; }
  set(row, col, v) {
    while (this.data.length < row) this.data.push([]);
    // Sheets drops the leading apostrophe that forces text.
    if (typeof v === 'string' && v.startsWith("'")) v = v.slice(1);
    if (v instanceof Date) v = this.makeDate(v);
    this.data[row - 1][col - 1] = v;
  }
  isEmptyRow(r) { return !r || r.every((v) => v === '' || v === undefined || v === null); }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if (!this.isEmptyRow(this.data[i])) return i + 1;
    return 0;
  }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r ? r.length : 0), 0); }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error(`Bad range ${row},${col},${numRows},${numCols}`);
    return new MockRange(this, row, col, numRows, numCols);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  appendRow(values) { const r = this.getLastRow() + 1; values.forEach((v, j) => this.set(r, j + 1, v)); return this; }
  setFrozenRows() { return this; }
  toObjects() {
    const [h, ...rows] = this.getDataRange().getValues();
    return rows.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
  }
}

class MockSpreadsheet {
  constructor() { this.sheets = new Map(); this.makeDate = (d) => new Date(d.getTime()); }
  getSheetByName(n) { return this.sheets.get(n) || null; }
  insertSheet(n) { const s = new MockSheet(n, (d) => this.makeDate(d)); this.sheets.set(n, s); return s; }
  getSheets() { return [...this.sheets.values()]; }
}

function makeCache(clock) {
  const store = new Map();
  return {
    store,
    get(k) { const e = store.get(k); if (!e) return null; if (e.exp <= clock.now()) { store.delete(k); return null; } return e.v; },
    put(k, v, ttl = 600) { store.set(k, { v: String(v), exp: clock.now() + Math.min(ttl, 21600) * 1000 }); },
    remove(k) { store.delete(k); }
  };
}

// Java SimpleDateFormat subset used by the portal.
function formatDate(date, tz, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const map = {
    yyyy: parts.year, yy: parts.year.slice(2), MMM: months[Number(parts.month) - 1], MM: parts.month,
    dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second, EEE: parts.weekday
  };
  return pattern.replace(/'([^']*)'|yyyy|yy|MMM|MM|dd|HH|mm|ss|EEE/g, (m, lit) => (lit !== undefined ? lit : map[m]));
}

function tzOffsetMinutes(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(date).map((x) => [x.type, Number(x.value)]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime()) / 60000;
}

function parseDate(str, tz, pattern) {
  const tokens = [];
  const re = pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss/g, (m, lit) => {
    if (lit !== undefined) return lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    tokens.push(m);
    return m === 'yyyy' ? '(\\d{4})' : '(\\d{2})';
  });
  const m = new RegExp('^' + re + '$').exec(str);
  if (!m) throw new Error(`Unparseable date "${str}" for pattern ${pattern}`);
  const v = { yyyy: 1970, MM: 1, dd: 1, HH: 0, mm: 0, ss: 0 };
  tokens.forEach((t, i) => { v[t] = Number(m[i + 1]); });
  const guess = Date.UTC(v.yyyy, v.MM - 1, v.dd, v.HH, v.mm, v.ss);
  return new Date(guess - tzOffsetMinutes(tz, new Date(guess)) * 60000);
}

export function createRuntime({ effectiveUser = 'cfo@finchglow.com', timeZone = 'Africa/Lagos', now } = {}) {
  let offset = 0;
  const clock = { now: () => (now ? now.getTime() : Date.now()) + offset };
  const ss = new MockSpreadsheet();
  const cache = makeCache(clock);
  const props = new Map();
  const outbox = [];
  const mail = { failFor: new Set(), quota: 1500 };
  const logs = [];

  const RealDate = Date;
  class ClockDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(clock.now()); else super(...args); }
    static now() { return clock.now(); }
  }
  ss.makeDate = (d) => new ClockDate(d.getTime());

  const context = {
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    Date: ClockDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss,
      getUi: () => { throw new Error('No UI in tests'); }
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => { props.set(k, String(v)); } })
    },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    MailApp: {
      sendEmail(opts) {
        if (typeof opts !== 'object') throw new Error('Use the object form of sendEmail');
        const all = [opts.to, opts.cc].filter(Boolean).join(',').split(',');
        if (all.some((a) => mail.failFor.has(a.trim()))) throw new Error('Invalid email: ' + opts.to);
        mail.quota -= all.length;
        outbox.push({ ...opts });
      },
      getRemainingDailyQuota: () => mail.quota
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest(alg, text) {
        return [...crypto.createHash(alg).update(String(text), 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b));
      },
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, p) => formatDate(d, tz, p),
      parseDate: (s, tz, p) => new ClockDate(parseDate(s, tz, p).getTime())
    },
    Session: {
      getScriptTimeZone: () => timeZone,
      getEffectiveUser: () => ({ getEmail: () => effectiveUser })
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/DEV/exec' }) },
    HtmlService: {}
  };
  vm.createContext(context);

  const files = fs.readdirSync(SCRIPT_DIR).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPT_DIR, f), 'utf8'), context, { filename: f });
  }

  return {
    context,
    ss,
    cache,
    props,
    outbox,
    mail,
    logs,
    advance(ms) { offset += ms; },
    sheet(name) { return ss.getSheetByName(name); },
    /** Calls api() and fails loudly if the response could not cross google.script.run. */
    call(token, action, payload) {
      const res = context.api(token, action, payload);
      assertTransportable(res, action);
      return JSON.parse(JSON.stringify(res));
    }
  };
}

// google.script.run cannot return Date objects or functions. Catch that here rather than in production.
function assertTransportable(v, where) {
  if (v instanceof Date || (v && v.constructor && v.constructor.name === 'ClockDate')) {
    throw new Error(`${where}: response contains a Date, which google.script.run cannot return`);
  }
  if (typeof v === 'function') throw new Error(`${where}: response contains a function`);
  if (v && typeof v === 'object') for (const k of Object.keys(v)) assertTransportable(v[k], `${where}.${k}`);
}

/** Pulls the 6 digit code out of the last sign in email sent to `email`. */
export function lastCodeFor(rt, email) {
  const msg = [...rt.outbox].reverse().find((m) => m.to === email && /sign in code/.test(m.subject));
  return msg ? /(\d{6})/.exec(msg.subject)[1] : null;
}

/** Signs a user in through the real email code flow and returns the session token. */
export function signIn(rt, email) {
  const r1 = rt.call(null, 'requestCode', { email });
  if (!r1.ok) throw new Error(r1.error);
  const code = lastCodeFor(rt, email);
  if (!code) throw new Error('No code emailed to ' + email);
  const r2 = rt.call(null, 'verifyCode', { email, code });
  if (!r2.ok) throw new Error(r2.error);
  rt.advance(61 * 1000); // let the resend cooldown pass for the next sign in
  return r2.data.token;
}
