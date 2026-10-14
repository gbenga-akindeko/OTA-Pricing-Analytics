/**
 * Access control.
 *
 * Only people listed (and active) in the Users tab can sign in. Sign in is
 * passwordless: the portal emails a 6 digit code that is valid for 10 minutes.
 * A successful sign in returns a random session token that the browser keeps
 * for the tab. Every server call re-checks the Users tab, so deactivating a
 * user or changing their role takes effect immediately.
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

function publicUser_(row) {
  var role = String(row['Role']).trim().toUpperCase();
  return {
    email: normEmail_(row['Email']),
    name: String(row['Full Name'] || '').trim() || normEmail_(row['Email']),
    role: role,
    roleLabel: ROLES[role] ? ROLES[role].label : role,
    subsidiary: String(row['Subsidiary'] || '')
  };
}

function isActiveUser_(row) {
  return !!row && toBool_(row['Active']) && !!ROLES[String(row['Role']).trim().toUpperCase()];
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

/** Resolves a session token to an active user, enforcing the minimum role. */
function requireUser_(token, minRole, action) {
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
  if (ROLES[user.role].rank < ROLES[minRole].rank) {
    audit_(user.email, 'ACCESS_DENIED', 'Tried ' + (action || 'a restricted action') + ' as ' + user.role);
    throw new AppError('You do not have permission to do that.', 'FORBIDDEN');
  }
  cache.put(key, raw, AUTH.SESSION_IDLE_SECONDS);
  return user;
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
