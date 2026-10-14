/**
 * First-time setup. Run `setup` once from the Apps Script editor (or the
 * "Finance Portal" menu in the sheet). It is safe to run again: it only adds
 * what is missing and never deletes data.
 */

function setup() {
  var me = normEmail_(Session.getEffectiveUser().getEmail());
  Object.keys(SHEETS).forEach(function (k) { getSheet_(SHEETS[k]); });

  // Settings: add any keys that are missing.
  var existingKeys = readTable_(SHEETS.SETTINGS).map(function (r) { return String(r['Key']).trim(); });
  appendRows_(SHEETS.SETTINGS, DEFAULT_SETTINGS.filter(function (d) {
    return existingKeys.indexOf(d[0]) === -1;
  }).map(function (d) {
    return { 'Key': d[0], 'Value': d[1], 'Description': d[2] };
  }));

  if (!readTable_(SHEETS.CATEGORIES).length) {
    appendRows_(SHEETS.CATEGORIES, DEFAULT_CATEGORIES.map(function (c) {
      return { 'Currency': c[0], 'Display Name': c[1], 'Category': c[2], 'Sort Order': c[3], 'Active': c[4] };
    }));
  }

  if (!readTable_(SHEETS.SUBSIDIARIES).length) {
    appendRows_(SHEETS.SUBSIDIARIES, DEFAULT_SUBSIDIARIES.map(function (s) {
      return { 'Code': s[0], 'Subsidiary Name': s[1], 'Type': s[2], 'Head of Finance': '', 'Head of Finance Email': '', 'CC Emails': '', 'Active': s[3], 'Updated At': new Date(), 'Updated By': 'setup' };
    }));
  }

  if (!readTable_(SHEETS.BOOK).length) {
    appendRows_(SHEETS.BOOK, SEED_BOOK_RATES.map(function (b) {
      return {
        'Effective Date': Utilities.parseDate(b[0] + ' 00:00:00', tz_(), 'yyyy-MM-dd HH:mm:ss'),
        'USD': b[1], 'EUR': b[2], 'GBP': b[3]
      };
    }));
  }

  // The first person to run setup becomes the main admin, who always has full access.
  var props = PropertiesService.getScriptProperties();
  if (me && !props.getProperty('MAIN_ADMIN')) props.setProperty('MAIN_ADMIN', me);
  if (me && !findUser_(me)) {
    var row = { 'Email': me, 'Full Name': me, 'Role': 'ADMIN', 'Subsidiary': 'Holdings', 'Blocked': false, 'Active': true, 'Created At': new Date(), 'Created By': 'setup' };
    PERMISSIONS.forEach(function (p) { row[p.column] = true; });
    appendRows_(SHEETS.USERS, [row]);
  }

  authSecret_();
  formatSheets_();
  audit_(me, 'SETUP', 'Setup ran (version ' + APP_VERSION + ')');
  return 'Setup complete. ' + (me ? me + ' is an administrator.' : '');
}

function formatSheets_() {
  var formats = [
    [SHEETS.PUBLICATIONS, ['Effective At', 'Published At', 'Voided At'], 'dd/mm/yyyy hh:mm'],
    [SHEETS.ROE, ['Effective At'], 'dd/mm/yyyy hh:mm'],
    [SHEETS.ROE, ['Rate'], '#,##0.00'],
    [SHEETS.BOOK, ['Effective Date'], 'dd/mm/yyyy'],
    [SHEETS.BOOK, ['USD', 'EUR', 'GBP'], '#,##0.00'],
    [SHEETS.AUDIT, ['Timestamp'], 'dd/mm/yyyy hh:mm:ss'],
    [SHEETS.EMAIL_LOG, ['Timestamp'], 'dd/mm/yyyy hh:mm:ss'],
    [SHEETS.USERS, ['Created At', 'Last Login'], 'dd/mm/yyyy hh:mm']
  ];
  formats.forEach(function (f) {
    var sheet = getSheet_(f[0]);
    var headers = readHeaders_(sheet);
    f[1].forEach(function (h) {
      var col = headers.indexOf(h) + 1;
      if (col > 0) sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).setNumberFormat(f[2]);
    });
  });
}
