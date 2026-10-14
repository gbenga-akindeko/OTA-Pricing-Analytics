/**
 * Outgoing email. Mail is sent with MailApp from the account that deployed the
 * web app, so deploy from a finance mailbox rather than a personal one.
 */

function portalUrl_(settings) {
  if (settings.PORTAL_URL) return settings.PORTAL_URL;
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

function esc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function splitEmails_(s) {
  return String(s || '').split(/[,;\s]+/).map(normEmail_).filter(function (e) { return e; });
}

function mailOptions_(settings, extra) {
  var opts = { name: settings.EMAIL_SENDER_NAME || settings.COMPANY_NAME || 'Finance' };
  if (isEmail_(settings.REPLY_TO)) opts.replyTo = settings.REPLY_TO;
  for (var k in extra) opts[k] = extra[k];
  return opts;
}

/**
 * Orders the lines of a publication by currency the same way the broadcast
 * does (USD, POUNDS, EURO by default), using the Rate Categories tab.
 */
function orderedGroups_(pub) {
  var categories = getCategories_(true);
  var displayNames = {};
  var order = {};
  categories.forEach(function (c, i) {
    if (!displayNames[c.currency]) displayNames[c.currency] = c.displayName;
    if (order[c.currency] === undefined) order[c.currency] = i;
    order[rateKey_(c.currency, c.category)] = i;
  });
  var groups = {};
  var list = [];
  pub.rates.forEach(function (r) {
    if (!groups[r.currency]) {
      groups[r.currency] = { currency: r.currency, displayName: displayNames[r.currency] || r.currency, lines: [] };
      list.push(groups[r.currency]);
    }
    groups[r.currency].lines.push(r);
  });
  var rank = function (k) { return order[k] === undefined ? 9999 : order[k]; };
  list.sort(function (a, b) { return rank(a.currency) - rank(b.currency); });
  list.forEach(function (g) {
    g.lines.sort(function (a, b) { return rank(rateKey_(a.currency, a.category)) - rank(rateKey_(b.currency, b.category)); });
  });
  return list;
}

/** Plain text in the same layout as the WhatsApp broadcast. */
function buildRoeText_(pub, groups) {
  var d = new Date(pub.effectiveAt);
  var out = ['ROE for ' + fmtDate_(d, 'dd/MM/yy') + ' @' + fmtDate_(d, 'HH:mm'), ''];
  groups.forEach(function (g) {
    out.push(g.displayName + ' ROE:');
    g.lines.forEach(function (l) { out.push(formatRate_(l.rate) + ' - (' + l.category + ')'); });
    out.push('');
  });
  if (pub.note) out.push('Note: ' + pub.note);
  return out.join('\n').replace(/\n+$/, '');
}

function changeHtml_(change) {
  if (change === null || change === undefined) return '<span style="color:#898781">New</span>';
  if (change === 0) return '<span style="color:#898781">No change</span>';
  var up = change > 0;
  return '<span style="color:#52514e">' + (up ? '&#9650; +' : '&#9660; ') + esc_(formatRate_(change)) + '</span>';
}

function buildRoeEmail_(pub, settings, recipientName, kind) {
  var groups = orderedGroups_(pub);
  var d = new Date(pub.effectiveAt);
  var when = fmtDate_(d, 'dd/MM/yy') + ' @ ' + fmtDate_(d, 'HH:mm');
  var subject = (settings.EMAIL_SUBJECT_PREFIX ? settings.EMAIL_SUBJECT_PREFIX + ' ' : '') +
    (kind === 'RESEND' ? 'Resent: ' : '') + 'ROE for ' + when;
  var url = portalUrl_(settings);
  var text = buildRoeText_(pub, groups);
  var plain = (recipientName ? 'Dear ' + recipientName + ',\n\n' : '') +
    'Please find below the rate of exchange (ROE) published by ' + (settings.COMPANY_NAME || 'Finance') + '.\n\n' +
    text + '\n\nPublished by ' + pub.publishedBy.replace(/\s*<.*>$/, '') + (url ? '\nPortal: ' + url : '');

  var blocks = groups.map(function (g) {
    var rows = g.lines.map(function (l) {
      return '<tr>' +
        '<td style="padding:8px 12px;border-top:1px solid #e1e0d9;font-size:14px;color:#0b0b0b">' + esc_(l.category) + '</td>' +
        '<td style="padding:8px 12px;border-top:1px solid #e1e0d9;font-size:16px;font-weight:700;text-align:right;color:#0b0b0b;font-variant-numeric:tabular-nums">' + esc_(formatRate_(l.rate)) + '</td>' +
        '<td style="padding:8px 12px;border-top:1px solid #e1e0d9;font-size:12px;text-align:right;white-space:nowrap">' + changeHtml_(l.change) + '</td>' +
        '</tr>';
    }).join('');
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px;border:1px solid #e1e0d9;border-radius:8px">' +
      '<tr><td colspan="3" style="padding:10px 12px;background:#f3f6fa;font-size:13px;font-weight:700;letter-spacing:.04em;color:#1c3d5e">' + esc_(g.displayName) + ' ROE</td></tr>' +
      rows + '</table>';
  }).join('');

  var html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0b0b0b">' +
    brandHeader_(settings) +
    '<h1 style="margin:0 0 4px;font-size:22px;color:#0b0b0b">ROE for ' + esc_(when) + '</h1>' +
    (kind === 'RESEND' ? '<p style="margin:0 0 8px;font-size:13px;color:#52514e">This is a resend of an earlier email.</p>' : '') +
    (recipientName ? '<p style="margin:12px 0;font-size:14px">Dear ' + esc_(recipientName) + ',</p>' : '') +
    '<p style="margin:0 0 16px;font-size:14px">Please find below the rate of exchange (ROE) for your team.</p>' +
    blocks +
    (pub.note ? '<p style="margin:0 0 16px;padding:10px 12px;background:#fff8e6;border-left:3px solid #eda100;font-size:13px;font-weight:600;font-style:italic">Note: ' + esc_(pub.note) + '</p>' : '') +
    '<p style="margin:0 0 4px;font-size:12px;color:#52514e">Published by ' + esc_(pub.publishedBy.replace(/\s*<.*>$/, '')) + '. Change shown against the previous rate.</p>' +
    (url ? '<p style="margin:0 0 16px;font-size:12px"><a href="' + esc_(url) + '" style="color:#1c5cab">Open the Finance Portal</a></p>' : '') +
    '</div>';
  return { subject: subject, text: text, plain: plain, html: html };
}

/** Finchglow colour stripe plus the logo (when LOGO_URL is set) or the company name. */
function brandHeader_(settings) {
  var stripe = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>' +
    [['#00aeef', 40], ['#7b2d5e', 15], ['#a50b1f', 10], ['#00a651', 15], ['#f7901e', 20]].map(function (c) {
      return '<td width="' + c[1] + '%" style="height:4px;line-height:4px;font-size:0;background:' + c[0] + '">&nbsp;</td>';
    }).join('') + '</tr></table>';
  var logo = /^https:\/\//i.test(settings.LOGO_URL || '')
    ? '<img src="' + esc_(logoUrl_(settings.LOGO_URL)) + '" alt="' + esc_(settings.COMPANY_NAME || 'Finchglow Holdings') + '" height="40" style="display:block;height:40px;width:auto;border:0">'
    : '<span style="font-size:13px;font-weight:700;color:#0d6a94;text-transform:uppercase;letter-spacing:.08em">' + esc_(settings.COMPANY_NAME || 'Finance') + '</span>';
  return stripe + '<div style="padding:16px 0 12px">' + logo + '</div>';
}

function logEmail_(pubId, type, subsidiary, to, cc, status, detail) {
  appendRows_(SHEETS.EMAIL_LOG, [{
    'Timestamp': new Date(),
    'Publication ID': pubId,
    'Type': type,
    'Subsidiary': cellText_(subsidiary),
    'To': cellText_(to),
    'CC': cellText_(cc),
    'Status': status,
    'Detail': cellText_(detail)
  }]);
}

function activeSubsidiaries_() {
  return readTable_(SHEETS.SUBSIDIARIES).filter(function (r) {
    return toBool_(r['Active']) && isEmail_(normEmail_(r['Head of Finance Email']));
  });
}

/**
 * Emails a publication to the head of finance of every active subsidiary
 * (one email each, with that subsidiary's CC list) plus one copy to the
 * internal copy list. Each send is logged; a failure does not stop the rest.
 */
function broadcastPublication_(pubId, user, kind) {
  var pubs = loadPublications_();
  var timeline = rateTimeline_(pubs);
  var raw = pubs.filter(function (p) { return p.id === pubId; })[0];
  if (!raw) throw new AppError('Publication not found.', 'NOT_FOUND');
  if (raw.status !== 'ACTIVE') throw new AppError('A void publication cannot be emailed.', 'VALIDATION');
  var pub = serializePublication_(raw, timeline.before[raw.id]);
  var settings = getSettings_();
  var type = kind || 'ROE';

  var results = [];
  activeSubsidiaries_().forEach(function (s) {
    var to = normEmail_(s['Head of Finance Email']);
    var cc = splitEmails_(s['CC Emails']).filter(isEmail_).join(',');
    var msg = buildRoeEmail_(pub, settings, String(s['Head of Finance'] || '').trim(), type);
    var opts = mailOptions_(settings, { to: to, subject: msg.subject, body: msg.plain, htmlBody: msg.html });
    if (cc) opts.cc = cc;
    try {
      MailApp.sendEmail(opts);
      logEmail_(pubId, type, s['Subsidiary Name'], to, cc, 'SENT', '');
      results.push({ subsidiary: String(s['Subsidiary Name']), to: to, ok: true });
    } catch (e) {
      logEmail_(pubId, type, s['Subsidiary Name'], to, cc, 'FAILED', e.message);
      results.push({ subsidiary: String(s['Subsidiary Name']), to: to, ok: false, error: e.message });
    }
  });

  var copyList = splitEmails_(settings.INTERNAL_COPY_EMAILS).filter(isEmail_);
  if (copyList.length) {
    var copy = buildRoeEmail_(pub, settings, '', type);
    try {
      MailApp.sendEmail(mailOptions_(settings, { to: copyList.join(','), subject: copy.subject, body: copy.plain, htmlBody: copy.html }));
      logEmail_(pubId, type, 'Internal copy', copyList.join(','), '', 'SENT', '');
    } catch (e) {
      logEmail_(pubId, type, 'Internal copy', copyList.join(','), '', 'FAILED', e.message);
    }
  }

  var sent = results.filter(function (r) { return r.ok; }).length;
  var total = results.length;
  var status = total === 0 ? 'NO RECIPIENTS' : sent === total ? 'SENT ' + sent + '/' + total : sent === 0 ? 'FAILED 0/' + total : 'PARTIAL ' + sent + '/' + total;
  updateRow_(SHEETS.PUBLICATIONS, raw.row, { 'Email Status': status });
  audit_(user.email, type === 'RESEND' ? 'RESEND_ROE' : 'EMAIL_ROE', { id: pubId, status: status });
  return { status: status, sent: sent, total: total, results: results };
}

function sendLoginCodeEmail_(email, name, code, settings) {
  var portal = settings.PORTAL_NAME || 'Finance Portal';
  var html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0b0b0b">' +
    '<p style="font-size:14px">Hello ' + esc_(name) + ',</p>' +
    '<p style="font-size:14px">Your sign in code for the ' + esc_(portal) + ' is:</p>' +
    '<p style="font-size:30px;font-weight:700;letter-spacing:.3em;margin:16px 0">' + esc_(code) + '</p>' +
    '<p style="font-size:13px;color:#52514e">It expires in 10 minutes. If you did not try to sign in, you can ignore this email.</p></div>';
  MailApp.sendEmail(mailOptions_(settings, {
    to: email,
    subject: portal + ' sign in code: ' + code,
    body: 'Hello ' + name + ',\n\nYour sign in code for the ' + portal + ' is ' + code + '.\nIt expires in 10 minutes. If you did not try to sign in, you can ignore this email.',
    htmlBody: html
  }));
}

/** Sends the latest ROE (or a short test note) to one subsidiary so admins can check the address. */
function sendTestEmail_(user, payload) {
  var code = String((payload && payload.code) || '');
  var sub = readTable_(SHEETS.SUBSIDIARIES).filter(function (r) { return String(r['Code']) === code; })[0];
  if (!sub) throw new AppError('Subsidiary not found.', 'NOT_FOUND');
  var to = normEmail_(sub['Head of Finance Email']);
  if (!isEmail_(to)) throw new AppError('This subsidiary has no valid head of finance email.', 'VALIDATION');
  var settings = getSettings_();
  var cc = splitEmails_(sub['CC Emails']).filter(isEmail_).join(',');
  var opts = mailOptions_(settings, {
    to: to,
    subject: (settings.EMAIL_SUBJECT_PREFIX ? settings.EMAIL_SUBJECT_PREFIX + ' ' : '') + 'Test email from the ' + (settings.PORTAL_NAME || 'Finance Portal'),
    body: 'Hello ' + (sub['Head of Finance'] || '') + ',\n\nThis is a test from the ' + (settings.PORTAL_NAME || 'Finance Portal') +
      '. You are set up to receive ROE updates for ' + sub['Subsidiary Name'] + '.\n\nSent by ' + user.name + '.'
  });
  if (cc) opts.cc = cc;
  MailApp.sendEmail(opts);
  logEmail_('', 'TEST', sub['Subsidiary Name'], to, cc, 'SENT', 'Test sent by ' + user.email);
  audit_(user.email, 'TEST_EMAIL', { subsidiary: code, to: to });
  return { to: to, cc: cc };
}
