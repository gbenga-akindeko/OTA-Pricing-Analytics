/**
 * Web app entry point and API router.
 *
 * The browser calls `api(token, action, payload)` through google.script.run.
 * Each action declares the permission it needs and whether it writes, in
 * which case it runs under the script lock so two people cannot publish at
 * the same moment.
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Finchglow Finance Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Used by Index.html to pull in Styles.html and Client.html. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

var API = {
  // Public (no session)
  config: { perm: null, fn: function () { return publicConfig_(); } },
  requestCode: { perm: null, lock: true, fn: function (u, p) { return requestCode_(p); } },
  verifyCode: { perm: null, lock: true, fn: function (u, p) { return verifyCode_(p); } },
  logout: { perm: null, fn: function (u, p, token) { return logout_(token); } },

  // Everyone signed in
  bootstrap: { perm: 'VIEW', fn: function (u) { return bootstrap_(u); } },
  current: { perm: 'VIEW', fn: function () { return getCurrent_(); } },
  history: { perm: 'VIEW', fn: function (u, p) { return getHistory_(p); } },
  fluctuations: { perm: 'VIEW', fn: function (u, p) { return getFluctuations_(p); } },
  bookRates: { perm: 'VIEW', fn: function () { return getBookRates_(); } },

  // Set rate permission
  publish: { perm: 'SET_RATE', lock: true, fn: function (u, p) { return publishRates_(u, p); } },
  resend: { perm: 'SET_RATE', lock: true, fn: function (u, p) { return broadcastPublication_(String(p && p.id), u, 'RESEND'); } },
  voidPublication: { perm: 'SET_RATE', lock: true, fn: function (u, p) { return voidPublication_(u, p); } },
  addBookRate: { perm: 'SET_RATE', lock: true, fn: function (u, p) { return addBookRate_(u, p); } },
  recipients: { perm: 'SET_RATE', fn: function () { return recipientSummary_(); } },

  // Admin pages (each needs its own permission; Admin has them all)
  users: { perm: 'ADMIN', fn: function () { return listUsers_(); } },
  saveUser: { perm: 'ADMIN', lock: true, fn: function (u, p) { return saveUser_(u, p); } },
  removeUser: { perm: 'ADMIN', lock: true, fn: function (u, p) { return removeUser_(u, p); } },
  subsidiaries: { perm: 'SUBSIDIARIES', fn: function () { return listSubsidiaries_(); } },
  saveSubsidiary: { perm: 'SUBSIDIARIES', lock: true, fn: function (u, p) { return saveSubsidiary_(u, p); } },
  testEmail: { perm: 'SUBSIDIARIES', lock: true, fn: function (u, p) { return sendTestEmail_(u, p); } },
  categories: { perm: 'SETTINGS', fn: function () { return listCategoriesAdmin_(); } },
  saveCategory: { perm: 'SETTINGS', lock: true, fn: function (u, p) { return saveCategory_(u, p); } },
  settings: { perm: 'SETTINGS', fn: function () { return getSettingsAdmin_(); } },
  saveSettings: { perm: 'SETTINGS', lock: true, fn: function (u, p) { return saveSettings_(u, p); } },
  audit: { perm: 'AUDIT', fn: function (u, p) { return getAudit_(p); } },
  emailLog: { perm: 'AUDIT', fn: function (u, p) { return getEmailLog_(p); } }
};

function api(token, action, payload) {
  try {
    var def = Object.prototype.hasOwnProperty.call(API, action) ? API[action] : null;
    if (!def) throw new AppError('Unknown action.', 'NOT_FOUND');
    var run = function () {
      var user = def.perm ? requireUser_(token, def.perm, action) : null;
      return def.fn(user, payload || {}, token);
    };
    return { ok: true, data: def.lock ? withLock_(run) : run() };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message, code: e.code, extra: e.extra };
    console.error(action + ' failed: ' + (e && e.stack ? e.stack : e));
    return { ok: false, error: 'Something went wrong: ' + (e && e.message ? e.message : e), code: 'SERVER' };
  }
}

function publicConfig_() {
  var s = getSettings_();
  return {
    companyName: s.COMPANY_NAME,
    portalName: s.PORTAL_NAME,
    logoUrl: /^https:\/\//i.test(s.LOGO_URL || '') ? logoUrl_(s.LOGO_URL) : '',
    // The default logo is also built into Logo.html, so the portal can show it without fetching from Drive.
    logoIsDefault: !s.LOGO_URL || logoUrl_(s.LOGO_URL) === DEFAULT_SETTINGS.filter(function (d) { return d[0] === 'LOGO_URL'; })[0][1]
  };
}

function bootstrap_(user) {
  var s = getSettings_();
  return {
    user: user,
    config: publicConfig_(),
    timezone: tz_(),
    validityNote: s.VALIDITY_NOTE,
    largeChangePercent: Number(s.LARGE_CHANGE_PERCENT) || 0,
    categories: groupCategories_(getCategories_(false)),
    version: APP_VERSION
  };
}

/** Who will receive the email when a rate is published. Shown on the publish form. */
function recipientSummary_() {
  var settings = getSettings_();
  return {
    subsidiaries: activeSubsidiaries_().map(function (s) {
      return { name: String(s['Subsidiary Name']), headName: String(s['Head of Finance'] || ''), email: normEmail_(s['Head of Finance Email']) };
    }),
    internalCopy: splitEmails_(settings.INTERNAL_COPY_EMAILS).filter(isEmail_)
  };
}

/** Adds a menu to the database sheet. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Finance Portal')
    .addItem('Run first-time setup', 'setup')
    .addItem('Show portal link', 'showPortalLink')
    .addToUi();
}

function showPortalLink() {
  var url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(url ? 'Portal link:\n\n' + url : 'Deploy the script as a web app first (Deploy > New deployment > Web app).');
}
