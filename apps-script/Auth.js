/**
 * Access control.
 *
 * Only people listed (and active) in the Users tab can sign in. Sign in is
 * passwordless: the portal emails a 6 digit code that is valid for 10 minutes.
 * A successful sign in returns a random session token that the browser keeps
 * for the tab. Every server call re-checks the Users tab, so deactivating a
 * user or changing their access takes effect immediately.
 */

function normEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function isEmail_(email) {
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(String(email || ''));
}

function sha256_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function authSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('AUTH_SECRET');
  if (!secret) {
    secret = randomHex_() + randomHex_();
    props.setProperty('AUTH_SECRET', secret);
  }
  return secret;
}

/** 32 hex chars from a v4 UUID, which Apps Script builds from a secure random source. */
function randomHex_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function randomCode_() {
  var n = parseInt(randomHex_().slice(0, 12), 16) % 1000000;
  return ('000000' + n).slice(-6);
}

function findUser_(email) {
  var e = normEmail_(email);
  if (!e) return null;
  var rows = readTable_(SHEETS.USERS);
  for (var i = 0; i < rows.length; i++) {
    if (normEmail_(rows[i]['Email']) === e) return rows[i];
  }
  return null;
}

function isMainAdmin_(email) {
  var main = normEmail_(PropertiesService.getScriptProperties().getProperty('MAIN_ADMIN'));
  return !!main && main === normEmail_(email);
}

function hasCell_(row, column) {
  return Object.prototype.hasOwnProperty.call(row, column) && row[column] !== '' && row[column] !== null && row[column] !== undefined;
}

/** Permission flags for a Users row. Rows without tick box columns fall back to the old Role column. */
function allPages_() {
  var pages = {};
  PAGES.forEach(function (p) { pages[p.key] = true; });
  return pages;
}

function pagesFromList_(list) {
  var pages = {};
  PAGES.forEach(function (p) { pages[p.key] = list.indexOf(p.key) !== -1; });
  return pages;
}

/** Pages, admin and view only flags for a Users row. Older rows fall back to their Role or permission columns. */
function userAccess_(row) {
  if (isMainAdmin_(row['Email']) || toBool_(row['Admin']) || toBool_(row['Is Admin'])) {
    return { pages: allPages_(), admin: true, viewOnly: false };
  }
  if (hasCell_(row, 'Pages') || hasCell_(row, 'View Only')) {
    var list = String(row['Pages'] || '').toUpperCase().split(/[\s,;]+/).filter(function (k) { return k; });
    return { pages: pagesFromList_(list), admin: false, viewOnly: toBool_(row['View Only']) };
  }
  var legacy = LEGACY_ROLES[String(row['Role'] || 'VIEWER').trim().toUpperCase()] || DEFAULT_PAGES;
  if (legacy === 'ADMIN') return { pages: allPages_(), admin: true, viewOnly: false };
  var keys = legacy.slice();
  LEGACY_COLUMNS.forEach(function (c) { if (toBool_(row[c[0]])) keys = keys.concat(c[1]); });
  return { pages: pagesFromList_(keys), admin: false, viewOnly: false };
}

function isBlocked_(row) {
  if (isMainAdmin_(row['Email'])) return false;
  if (toBool_(row['Blocked'])) return true;
  return hasCell_(row, 'Active') && !toBool_(row['Active']);
}

/** Short description of someone's access, e.g. "Admin" or "Dashboard, ROE history (view only)". */
function accessLabel_(access, main) {
  if (main) return 'Main admin';
  if (access.admin) return 'Admin';
  var labels = PAGES.filter(function (p) { return access.pages[p.key]; }).map(function (p) { return p.label; });
  var text = labels.length === PAGES.length ? 'All pages' : labels.length ? labels.join(', ') : 'No pages';
  return text + (access.viewOnly ? ' (view only)' : '');
}

/** Role column kept in the sheet for people reading it directly. */
function roleFromAccess_(access) {
  return access.admin ? 'ADMIN' : access.pages.PUBLISH && !access.viewOnly ? 'RATE_SETTER' : 'VIEWER';
}

function publicUser_(row) {
  var access = userAccess_(row);
  var main = isMainAdmin_(row['Email']);
  var title = String(row['Job Title'] || '').trim();
  return {
    email: normEmail_(row['Email']),
    name: String(row['Full Name'] || '').trim() || normEmail_(row['Email']),
    title: title,
    pages: access.pages,
    admin: access.admin,
    viewOnly: access.viewOnly,
    isMainAdmin: main,
    access: accessLabel_(access, main),
    role: roleFromAccess_(access),
    roleLabel: title || (main ? 'Main admin' : access.admin ? 'Admin' : access.viewOnly ? 'View only' : 'Portal user'),
    subsidiary: String(row['Subsidiary'] || '')
  };
}

function isActiveUser_(row) {
  return !!row && !!normEmail_(row['Email']) && !isBlocked_(row);
}

/** Step 1 of sign in. The reply never reveals whether the email is registered. */
function requestCode_(payload) {
  var email = normEmail_(payload && payload.email);
  if (!isEmail_(email)) throw new AppError('Enter a valid email address.', 'VALIDATION');
  var generic = { message: 'If this email is registered on the portal, a sign in code has been sent to it.' };

  var cache = CacheService.getScriptCache();
  if (cache.get('otp_wait:' + email)) return generic;

  var user = findUser_(email);
  if (!isActiveUser_(user)) {
    audit_(email, 'LOGIN_CODE_DENIED', 'Email not registered or inactive');
    return generic;
  }

  var code = randomCode_();
  cache.put('otp:' + email, JSON.stringify({ hash: sha256_(authSecret_() + '|' + email + '|' + code), attempts: 0 }), AUTH.CODE_TTL_SECONDS);
  cache.put('otp_wait:' + email, '1', AUTH.CODE_RESEND_SECONDS);

  var settings = getSettings_();
  sendLoginCodeEmail_(email, publicUser_(user).name, code, settings);
  audit_(email, 'LOGIN_CODE_SENT', '');
  return generic;
}

/** Step 2 of sign in. Returns a session token on success. */
function verifyCode_(payload) {
  var email = normEmail_(payload && payload.email);
  var code = String((payload && payload.code) || '').replace(/\D/g, '');
  var cache = CacheService.getScriptCache();
  var raw = cache.get('otp:' + email);
  var fail = new AppError('That code is wrong or has expired. Request a new one.', 'BAD_CODE');
  if (!raw || code.length !== 6) {
    audit_(email, 'LOGIN_FAILED', raw ? 'Code was not 6 digits' : 'Code expired or never requested');
    throw fail;
  }

  var otp = JSON.parse(raw);
  otp.attempts += 1;
  if (otp.hash !== sha256_(authSecret_() + '|' + email + '|' + code)) {
    audit_(email, 'LOGIN_FAILED', 'Wrong code, attempt ' + otp.attempts);
    if (otp.attempts >= AUTH.CODE_MAX_ATTEMPTS) {
      cache.remove('otp:' + email);
      audit_(email, 'LOGIN_LOCKED', 'Too many wrong codes');
    } else {
      cache.put('otp:' + email, JSON.stringify(otp), AUTH.CODE_TTL_SECONDS);
    }
    throw fail;
  }
  cache.remove('otp:' + email);

  var user = findUser_(email);
  if (!isActiveUser_(user)) throw fail;

  var token = randomHex_() + randomHex_();
  var now = Date.now();
  cache.put('sess:' + sha256_(token), JSON.stringify({ email: email, iat: now }), AUTH.SESSION_IDLE_SECONDS);
  updateRow_(SHEETS.USERS, user._row, { 'Last Login': new Date() });
  audit_(email, 'LOGIN', '');
  return { token: token, user: publicUser_(user) };
}

/**
 * Resolves a session token to an active user and checks the action's access rule:
 *   'SIGNED_IN'                 any signed in person
 *   { pages: [...] }            at least one of these pages ticked
 *   { pages: [...], write: 1 }  ...and not view only
 *   { admin: true }             admin only
 * Admins pass every rule.
 */
function requireUser_(token, rule, action) {
  var expired = new AppError('Your session has expired. Please sign in again.', 'AUTH');
  if (!token || typeof token !== 'string' || token.length < 32) throw expired;
  var cache = CacheService.getScriptCache();
  var key = 'sess:' + sha256_(token);
  var raw = cache.get(key);
  if (!raw) throw expired;
  var sess = JSON.parse(raw);
  if (Date.now() - sess.iat > AUTH.SESSION_MAX_SECONDS * 1000) {
    cache.remove(key);
    throw expired;
  }
  var row = findUser_(sess.email);
  if (!isActiveUser_(row)) {
    cache.remove(key);
    audit_(sess.email, 'SESSION_REVOKED', 'User removed or deactivated while signed in');
    throw new AppError('Your portal access has been removed. Contact the CFO office.', 'AUTH');
  }
  var user = publicUser_(row);
  var reason = accessProblem_(user, rule);
  if (reason) {
    audit_(user.email, 'ACCESS_DENIED', 'Tried ' + (action || 'a restricted action') + ': ' + reason + ' (has: ' + user.access + ')');
    throw new AppError('You do not have permission to do that.', 'FORBIDDEN');
  }
  cache.put(key, raw, AUTH.SESSION_IDLE_SECONDS);
  return user;
}

/** Why `user` fails `rule`, or '' when they pass. */
function accessProblem_(user, rule) {
  if (!rule || rule === 'SIGNED_IN' || user.admin) return '';
  if (rule.admin) return 'needs Admin';
  if (rule.pages && !rule.pages.some(function (k) { return user.pages[k]; })) return 'needs page ' + rule.pages.join(' or ');
  if (rule.write && user.viewOnly) return 'view only';
  return '';
}

function logout_(token) {
  if (token && typeof token === 'string') {
    var cache = CacheService.getScriptCache();
    var key = 'sess:' + sha256_(token);
    var raw = cache.get(key);
    if (raw) {
      cache.remove(key);
      audit_(JSON.parse(raw).email, 'LOGOUT', '');
    }
  }
  return { loggedOut: true };
}
