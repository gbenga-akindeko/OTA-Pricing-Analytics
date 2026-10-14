/**
 * Administration: users and roles, subsidiaries and their heads of finance,
 * rate categories, settings, and the audit and email logs.
 */

function listUsers_() {
  return {
    users: readTable_(SHEETS.USERS).map(function (r) {
      var u = publicUser_(r);
      u.active = toBool_(r['Active']);
      u.lastLogin = iso_(r['Last Login']);
      u.lastLoginLabel = fmtDate_(r['Last Login'], 'dd/MM/yy HH:mm');
      return u;
    }),
    roles: Object.keys(ROLES).map(function (k) { return { value: k, label: ROLES[k].label }; })
  };
}

function saveUser_(user, payload) {
  payload = payload || {};
  var email = normEmail_(payload.email);
  if (!isEmail_(email)) throw new AppError('Enter a valid email address.', 'VALIDATION');
  var role = String(payload.role || '').toUpperCase();
  if (!ROLES[role]) throw new AppError('Choose a role.', 'VALIDATION');
  var active = payload.active !== false;
  var name = String(payload.name || '').trim();
  if (!name) throw new AppError('Enter the full name.', 'VALIDATION');

  var existing = findUser_(email);
  if (email === user.email && (!active || role !== 'ADMIN')) {
    throw new AppError('You cannot remove your own administrator access. Ask another administrator.', 'VALIDATION');
  }
  if (existing && String(existing['Role']).toUpperCase() === 'ADMIN' && toBool_(existing['Active']) && (!active || role !== 'ADMIN')) {
    var admins = readTable_(SHEETS.USERS).filter(function (r) {
      return String(r['Role']).toUpperCase() === 'ADMIN' && toBool_(r['Active']);
    });
    if (admins.length <= 1) throw new AppError('The portal must keep at least one active administrator.', 'VALIDATION');
  }

  var fields = {
    'Email': email,
    'Full Name': cellText_(name),
    'Role': role,
    'Subsidiary': cellText_(payload.subsidiary || ''),
    'Active': active
  };
  if (existing) {
    updateRow_(SHEETS.USERS, existing._row, fields);
    audit_(user.email, 'UPDATE_USER', {
      email: email,
      role: String(existing['Role']).toUpperCase() + ' -> ' + role,
      active: toBool_(existing['Active']) + ' -> ' + active
    });
  } else {
    fields['Created At'] = new Date();
    fields['Created By'] = user.email;
    appendRows_(SHEETS.USERS, [fields]);
    audit_(user.email, 'ADD_USER', { email: email, role: role });
  }
  return { email: email };
}

function listSubsidiaries_() {
  return {
    subsidiaries: readTable_(SHEETS.SUBSIDIARIES).map(function (r) {
      return {
        code: String(r['Code']),
        name: String(r['Subsidiary Name'] || ''),
        type: String(r['Type'] || 'Subsidiary'),
        headName: String(r['Head of Finance'] || ''),
        headEmail: normEmail_(r['Head of Finance Email']),
        cc: String(r['CC Emails'] || ''),
        active: toBool_(r['Active'])
      };
    }),
    types: SUBSIDIARY_TYPES
  };
}

function saveSubsidiary_(user, payload) {
  payload = payload || {};
  var code = String(payload.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) throw new AppError('Code must be 2 to 20 letters or numbers, e.g. FGT.', 'VALIDATION');
  var name = String(payload.name || '').trim();
  if (!name) throw new AppError('Enter the subsidiary name.', 'VALIDATION');
  var headEmail = normEmail_(payload.headEmail);
  if (!isEmail_(headEmail)) throw new AppError('Enter a valid head of finance email.', 'VALIDATION');
  var cc = splitEmails_(payload.cc);
  var bad = cc.filter(function (e) { return !isEmail_(e); });
  if (bad.length) throw new AppError('These CC emails are not valid: ' + bad.join(', '), 'VALIDATION');

  var fields = {
    'Code': code,
    'Subsidiary Name': cellText_(name),
    'Type': SUBSIDIARY_TYPES.indexOf(payload.type) === -1 ? 'Subsidiary' : payload.type,
    'Head of Finance': cellText_(payload.headName || ''),
    'Head of Finance Email': headEmail,
    'CC Emails': cc.join(', '),
    'Active': payload.active !== false,
    'Updated At': new Date(),
    'Updated By': user.email
  };
  var existing = readTable_(SHEETS.SUBSIDIARIES).filter(function (r) { return String(r['Code']).toUpperCase() === code; })[0];
  if (existing) {
    updateRow_(SHEETS.SUBSIDIARIES, existing._row, fields);
    audit_(user.email, 'UPDATE_SUBSIDIARY', {
      code: code,
      headEmail: normEmail_(existing['Head of Finance Email']) + ' -> ' + headEmail,
      active: fields['Active']
    });
  } else {
    appendRows_(SHEETS.SUBSIDIARIES, [fields]);
    audit_(user.email, 'ADD_SUBSIDIARY', { code: code, name: name, headEmail: headEmail });
  }
  return { code: code };
}

function listCategoriesAdmin_() {
  return { categories: getCategories_(true) };
}

function saveCategory_(user, payload) {
  payload = payload || {};
  var currency = String(payload.currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError('Currency must be a 3 letter code such as USD.', 'VALIDATION');
  var category = String(payload.category || '').trim();
  if (!category || category.length > 60) throw new AppError('Enter a category name (up to 60 characters).', 'VALIDATION');
  var displayName = String(payload.displayName || currency).trim().toUpperCase().slice(0, 20);
  var sortOrder = Number(payload.sortOrder);
  if (!isFinite(sortOrder)) sortOrder = 999;
  var active = payload.active !== false;

  var existing = getCategories_(true).filter(function (c) {
    return c.currency === currency && c.category.toLowerCase() === category.toLowerCase();
  })[0];
  var fields = { 'Currency': currency, 'Display Name': cellText_(displayName), 'Category': cellText_(category), 'Sort Order': sortOrder, 'Active': active };
  if (existing) {
    updateRow_(SHEETS.CATEGORIES, existing.row, fields);
    audit_(user.email, 'UPDATE_CATEGORY', fields);
  } else {
    appendRows_(SHEETS.CATEGORIES, [fields]);
    audit_(user.email, 'ADD_CATEGORY', fields);
  }
  return { currency: currency, category: category };
}

var EDITABLE_SETTINGS = ['COMPANY_NAME', 'LOGO_URL', 'PORTAL_NAME', 'VALIDITY_NOTE', 'EMAIL_SUBJECT_PREFIX', 'EMAIL_SENDER_NAME', 'REPLY_TO', 'INTERNAL_COPY_EMAILS', 'LARGE_CHANGE_PERCENT', 'PORTAL_URL'];

function getSettingsAdmin_() {
  var settings = getSettings_();
  var quota = null;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = null; }
  return {
    settings: EDITABLE_SETTINGS.map(function (k) {
      var def = DEFAULT_SETTINGS.filter(function (d) { return d[0] === k; })[0];
      return { key: k, value: settings[k] || '', description: def ? def[2] : '' };
    }),
    mailQuota: quota,
    version: APP_VERSION
  };
}

function saveSettings_(user, payload) {
  var values = (payload && payload.values) || {};
  var current = readTable_(SHEETS.SETTINGS);
  var changed = [];
  Object.keys(values).forEach(function (key) {
    if (EDITABLE_SETTINGS.indexOf(key) === -1) return;
    var value = String(values[key] === null || values[key] === undefined ? '' : values[key]).trim().slice(0, 1000);
    if (key === 'LOGO_URL') value = logoUrl_(value);
    if (key === 'REPLY_TO' && value && !isEmail_(value)) throw new AppError('Reply-to must be a valid email.', 'VALIDATION');
    if (key === 'INTERNAL_COPY_EMAILS') {
      var bad = splitEmails_(value).filter(function (e) { return !isEmail_(e); });
      if (bad.length) throw new AppError('These copy emails are not valid: ' + bad.join(', '), 'VALIDATION');
    }
    if (key === 'LARGE_CHANGE_PERCENT' && value && !(Number(value) >= 0)) throw new AppError('Large change percent must be a number.', 'VALIDATION');
    if ((key === 'LOGO_URL' || key === 'PORTAL_URL') && value && !/^https:\/\//i.test(value)) {
      throw new AppError('Links must start with https://', 'VALIDATION');
    }
    var row = current.filter(function (r) { return String(r['Key']).trim() === key; })[0];
    var before = row ? String(row['Value']) : '';
    if (before === value) return;
    if (row) updateRow_(SHEETS.SETTINGS, row._row, { 'Value': cellText_(value) });
    else {
      var def = DEFAULT_SETTINGS.filter(function (d) { return d[0] === key; })[0];
      appendRows_(SHEETS.SETTINGS, [{ 'Key': key, 'Value': cellText_(value), 'Description': def ? def[2] : '' }]);
    }
    changed.push(key);
  });
  if (changed.length) audit_(user.email, 'UPDATE_SETTINGS', { keys: changed });
  return { changed: changed };
}

/**
 * Turns a Google Drive share link (drive.google.com/file/d/ID/view, open?id=ID, uc?id=ID)
 * into a direct image link that works in the portal and in emails. Other links pass through.
 */
function logoUrl_(value) {
  var s = String(value || '').trim();
  var m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([A-Za-z0-9_-]{20,})/.exec(s);
  return m ? 'https://lh3.googleusercontent.com/d/' + m[1] : s;
}

/** Newest first, filtered by category, user text and date range. Capped to keep responses small. */
function getAudit_(payload) {
  payload = payload || {};
  var category = String(payload.category || '').toUpperCase();
  var q = String(payload.q || '').trim().toLowerCase();
  var from = parseDay_(payload.from, false);
  var to = parseDay_(payload.to, true);
  var limit = Math.min(Number(payload.limit) || 500, 2000);
  var rows = readTable_(SHEETS.AUDIT);
  var out = [];
  for (var i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    var r = rows[i];
    var ts = r['Timestamp'] instanceof Date ? r['Timestamp'] : new Date(r['Timestamp']);
    var cat = String(r['Category'] || AUDIT_CATEGORIES[r['Action']] || 'CHANGE').toUpperCase();
    if (category && cat !== category) continue;
    if (from && ts < from) continue;
    if (to && ts > to) continue;
    var userEmail = String(r['User'] || '');
    var details = String(r['Details'] || '');
    var action = String(r['Action'] || '');
    if (q && (userEmail + ' ' + action + ' ' + details).toLowerCase().indexOf(q) === -1) continue;
    out.push({ at: iso_(ts), label: fmtDate_(ts, 'dd/MM/yy HH:mm:ss'), user: userEmail, category: cat, action: action, details: details });
  }

  // Summary for the access panel: sign ins and failed attempts in the last 30 days.
  var since = new Date(Date.now() - 30 * 86400000);
  var summary = { logins: 0, failed: 0, denied: 0, changes: 0, activeUsers: {} };
  rows.forEach(function (r) {
    var ts = r['Timestamp'] instanceof Date ? r['Timestamp'] : new Date(r['Timestamp']);
    if (ts < since) return;
    var a = String(r['Action']);
    if (a === 'LOGIN') { summary.logins++; summary.activeUsers[String(r['User'])] = true; }
    else if (a === 'LOGIN_FAILED' || a === 'LOGIN_LOCKED' || a === 'LOGIN_CODE_DENIED') summary.failed++;
    else if (a === 'ACCESS_DENIED') summary.denied++;
    else if ((AUDIT_CATEGORIES[a] || 'CHANGE') === 'CHANGE') summary.changes++;
  });
  summary.activeUsers = Object.keys(summary.activeUsers).length;
  return { entries: out, summary: summary, truncated: out.length >= limit };
}

function getEmailLog_(payload) {
  var limit = Math.min(Number(payload && payload.limit) || 300, 2000);
  var rows = readTable_(SHEETS.EMAIL_LOG);
  var out = [];
  for (var i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    var r = rows[i];
    out.push({
      label: fmtDate_(r['Timestamp'] instanceof Date ? r['Timestamp'] : new Date(r['Timestamp']), 'dd/MM/yy HH:mm'),
      publicationId: String(r['Publication ID'] || ''),
      type: String(r['Type'] || ''),
      subsidiary: String(r['Subsidiary'] || ''),
      to: String(r['To'] || ''),
      cc: String(r['CC'] || ''),
      status: String(r['Status'] || ''),
      detail: String(r['Detail'] || '')
    });
  }
  return { entries: out };
}
