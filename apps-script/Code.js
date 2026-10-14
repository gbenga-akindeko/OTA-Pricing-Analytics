/**
 * Web app entry point and API router.
 *
 * The browser calls `api(token, action, payload)` through google.script.run.
 * Each action declares the pages it belongs to and whether it writes, in
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
  config: { access: null, fn: function () { return publicConfig_(); } },
  requestCode: { access: null, lock: true, fn: function (u, p) { return requestCode_(p); } },
  verifyCode: { access: null, lock: true, fn: function (u, p) { return verifyCode_(p); } },
  logout: { access: null, fn: function (u, p, token) { return logout_(token); } },

  // Exchange rate pages
  bootstrap: { access: 'SIGNED_IN', fn: function (u) { return bootstrap_(u); } },
  current: { access: { pages: ['DASHBOARD', 'PUBLISH'] }, fn: function () { return getCurrent_(); } },
  fluctuations: { access: { pages: ['DASHBOARD', 'FLUCTUATIONS'] }, fn: function (u, p) { return getFluctuations_(p); } },
  history: { access: { pages: ['HISTORY'] }, fn: function (u, p) { return getHistory_(p); } },
  bookRates: { access: { pages: ['BOOK'] }, fn: function () { return getBookRates_(); } },
  addBookRate: { access: { pages: ['BOOK'], write: true }, lock: true, fn: function (u, p) { return addBookRate_(u, p); } },
  recipients: { access: { pages: ['PUBLISH'] }, fn: function () { return recipientSummary_(); } },
  publish: { access: { pages: ['PUBLISH'], write: true }, lock: true, fn: function (u, p) { return publishRates_(u, p); } },
  resend: { access: { pages: ['PUBLISH'], write: true }, lock: true, fn: function (u, p) { return broadcastPublication_(String(p && p.id), u, 'RESEND'); } },
  voidPublication: { access: { pages: ['PUBLISH'], write: true }, lock: true, fn: function (u, p) { return voidPublication_(u, p); } },

  // Administration pages
  audit: { access: { pages: ['AUDIT'] }, fn: function (u, p) { return getAudit_(p); } },
  emailLog: { access: { pages: ['AUDIT'] }, fn: function (u, p) { return getEmailLog_(p); } },
  subsidiaries: { access: { pages: ['SUBSIDIARIES'] }, fn: function () { return listSubsidiaries_(); } },
  saveSubsidiary: { access: { pages: ['SUBSIDIARIES'], write: true }, lock: true, fn: function (u, p) { return saveSubsidiary_(u, p); } },
  testEmail: { access: { pages: ['SUBSIDIARIES'], write: true }, lock: true, fn: function (u, p) { return sendTestEmail_(u, p); } },
  categories: { access: { pages: ['CATEGORIES'] }, fn: function () { return listCategoriesAdmin_(); } },
  saveCategory: { access: { pages: ['CATEGORIES'], write: true }, lock: true, fn: function (u, p) { return saveCategory_(u, p); } },
  settings: { access: { pages: ['SETTINGS'] }, fn: function () { return getSettingsAdmin_(); } },
  saveSettings: { access: { pages: ['SETTINGS'], write: true }, lock: true, fn: function (u, p) { return saveSettings_(u, p); } },

  // Users & access (admins only)
  users: { access: { admin: true }, fn: function () { return listUsers_(); } },
  saveUser: { access: { admin: true }, lock: true, fn: function (u, p) { return saveUser_(u, p); } },
  removeUser: { access: { admin: true }, lock: true, fn: function (u, p) { return removeUser_(u, p); } }
};

function api(token, action, payload) {
  try {
    var def = Object.prototype.hasOwnProperty.call(API, action) ? API[action] : null;
    if (!def) throw new AppError('Unknown action.', 'NOT_FOUND');
    var run = function () {
      var user = def.access ? requireUser_(token, def.access, action) : null;
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
    pages: PAGES.map(function (p) { return { key: p.key, label: p.label, group: p.group }; }),
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
