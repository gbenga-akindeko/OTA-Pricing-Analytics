/**
 * Thin data layer over the Google Sheet. Each tab is treated as a table whose
 * first row holds the column headers.
 */

/**
 * The database sheet: the SPREADSHEET_ID script property if set, otherwise the
 * Finance database sheet in Config.js. This works whether or not the script
 * project is attached to the sheet.
 */
function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || DATABASE_SPREADSHEET_ID;
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new AppError('Database sheet not found. Set the SPREADSHEET_ID script property.', 'CONFIG');
  return ss;
}

/** Returns the tab for a SHEETS entry, creating it with headers when missing. */
function getSheet_(def) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(def.name);
  if (!sheet) {
    sheet = ss.insertSheet(def.name);
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readHeaders_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}

/** Reads every row as an object keyed by header. `_row` holds the sheet row number. */
function readTable_(def) {
  var sheet = getSheet_(def);
  var lastRow = sheet.getLastRow();
  var headers = readHeaders_(sheet);
  if (lastRow < 2 || !headers.length) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var empty = true;
    var obj = { _row: i + 2 };
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      obj[headers[c]] = row[c];
      if (row[c] !== '' && row[c] !== null) empty = false;
    }
    if (!empty) out.push(obj);
  }
  return out;
}

function rowFromObject_(headers, obj, existing) {
  return headers.map(function (h, i) {
    if (h && Object.prototype.hasOwnProperty.call(obj, h)) return obj[h];
    return existing ? existing[i] : '';
  });
}

/** Appends objects in one write. Missing headers are added to the sheet. */
function appendRows_(def, objects) {
  if (!objects.length) return;
  var sheet = getSheet_(def);
  var headers = ensureHeaders_(sheet, def);
  var rows = objects.map(function (o) { return rowFromObject_(headers, o); });
  // appendRow is atomic in Sheets, so single-row log writes are safe without the script lock.
  if (rows.length === 1) {
    sheet.appendRow(rows[0]);
    return;
  }
  var start = Math.max(sheet.getLastRow(), 1) + 1;
  sheet.getRange(start, 1, rows.length, headers.length).setValues(rows);
}

/** Updates the given fields of an existing row, leaving other columns untouched. */
function updateRow_(def, rowNumber, fields) {
  var sheet = getSheet_(def);
  var headers = ensureHeaders_(sheet, def);
  var range = sheet.getRange(rowNumber, 1, 1, headers.length);
  var existing = range.getValues()[0];
  range.setValues([rowFromObject_(headers, fields, existing)]);
}

function ensureHeaders_(sheet, def) {
  var headers = readHeaders_(sheet);
  var missing = def.headers.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    headers = headers.concat(missing);
  }
  return headers;
}

/**
 * Makes user supplied text safe to store in a cell. A leading = + - or @ would
 * otherwise be treated as a formula by Sheets.
 */
function cellText_(value) {
  var s = value === null || value === undefined ? '' : String(value).trim();
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function toBool_(v) {
  if (v === true || v === false) return v;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

/** Audit categories so the log can be filtered into access events, data changes and emails. */
var AUDIT_CATEGORIES = {
  LOGIN: 'ACCESS', LOGOUT: 'ACCESS', LOGIN_CODE_SENT: 'ACCESS', LOGIN_CODE_DENIED: 'ACCESS',
  LOGIN_FAILED: 'ACCESS', LOGIN_LOCKED: 'ACCESS', ACCESS_DENIED: 'ACCESS', SESSION_REVOKED: 'ACCESS',
  EMAIL_ROE: 'EMAIL', RESEND_ROE: 'EMAIL', TEST_EMAIL: 'EMAIL'
};

function audit_(userEmail, action, details) {
  appendRows_(SHEETS.AUDIT, [{
    'Timestamp': new Date(),
    'User': userEmail || 'system',
    'Category': AUDIT_CATEGORIES[action] || 'CHANGE',
    'Action': action,
    'Details': cellText_(typeof details === 'string' ? details : JSON.stringify(details))
  }]);
}

/** Settings tab as a key/value map, with defaults for anything missing. */
function getSettings_() {
  var map = {};
  DEFAULT_SETTINGS.forEach(function (d) { map[d[0]] = d[1]; });
  readTable_(SHEETS.SETTINGS).forEach(function (r) {
    var key = String(r['Key']).trim();
    if (key) map[key] = r['Value'] === null || r['Value'] === undefined ? '' : String(r['Value']);
  });
  return map;
}

function tz_() {
  return Session.getScriptTimeZone() || 'Africa/Lagos';
}

function fmtDate_(d, pattern) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, tz_(), pattern);
}

function iso_(d) {
  return d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : '';
}

/** Error with a machine readable code that the client understands. */
function AppError(message, code, extra) {
  this.name = 'AppError';
  this.message = message;
  this.code = code || 'ERROR';
  this.extra = extra || null;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new AppError('The portal is busy. Please try again in a moment.', 'BUSY');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
