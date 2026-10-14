/**
 * ROE (rate of exchange) publications.
 *
 * A publication is one broadcast such as "ROE for 12/10/26 @08:02". It has one
 * row in "ROE Publications" and one row per rate line in "ROE Log". Voided
 * publications stay in the sheet for the audit trail but no longer count as
 * the current rate.
 */

function getCategories_(includeInactive) {
  var rows = readTable_(SHEETS.CATEGORIES).map(function (r) {
    return {
      row: r._row,
      currency: String(r['Currency']).trim().toUpperCase(),
      displayName: String(r['Display Name'] || r['Currency']).trim(),
      category: String(r['Category']).trim(),
      sortOrder: Number(r['Sort Order']) || 0,
      active: toBool_(r['Active'])
    };
  }).filter(function (c) { return c.currency && c.category && (includeInactive || c.active); });
  rows.sort(function (a, b) { return a.sortOrder - b.sortOrder; });
  return rows;
}

/** Groups categories by currency, keeping the sort order of the first category of each currency. */
function groupCategories_(categories) {
  var groups = [];
  var byCode = {};
  categories.forEach(function (c) {
    if (!byCode[c.currency]) {
      byCode[c.currency] = { currency: c.currency, displayName: c.displayName, categories: [] };
      groups.push(byCode[c.currency]);
    }
    byCode[c.currency].categories.push(c.category);
  });
  return groups;
}

function rateKey_(currency, category) {
  return currency + '||' + category;
}

/** All publications (newest first) with their rate lines attached. */
function loadPublications_() {
  var lines = {};
  readTable_(SHEETS.ROE).forEach(function (r) {
    var id = String(r['Publication ID']);
    (lines[id] = lines[id] || []).push({
      currency: String(r['Currency']).trim().toUpperCase(),
      category: String(r['Category']).trim(),
      rate: Number(r['Rate'])
    });
  });
  var pubs = readTable_(SHEETS.PUBLICATIONS).map(function (r) {
    var id = String(r['Publication ID']);
    return {
      row: r._row,
      id: id,
      effectiveAt: r['Effective At'] instanceof Date ? r['Effective At'] : new Date(r['Effective At']),
      publishedAt: r['Published At'] instanceof Date ? r['Published At'] : new Date(r['Published At']),
      publishedBy: String(r['Published By'] || ''),
      note: String(r['Note'] || ''),
      status: String(r['Status'] || 'ACTIVE').toUpperCase(),
      emailStatus: String(r['Email Status'] || ''),
      voidReason: String(r['Void Reason'] || ''),
      voidedBy: String(r['Voided By'] || ''),
      rates: lines[id] || []
    };
  });
  pubs.sort(function (a, b) {
    return (b.effectiveAt - a.effectiveAt) || (b.publishedAt - a.publishedAt);
  });
  return pubs;
}

/**
 * Walks publications from oldest to newest and returns:
 *   current: latest active rate per currency/category
 *   before:  for each publication id, the active rates that applied just before it
 * A category left blank in a publication keeps its previous value, which
 * matches how the broadcasts work.
 */
function rateTimeline_(pubs) {
  var running = {};
  var before = {};
  for (var i = pubs.length - 1; i >= 0; i--) {
    var p = pubs[i];
    var snapshot = {};
    for (var k in running) snapshot[k] = running[k];
    before[p.id] = snapshot;
    if (p.status !== 'ACTIVE') continue;
    p.rates.forEach(function (r) {
      running[rateKey_(r.currency, r.category)] = { rate: r.rate, pubId: p.id, effectiveAt: p.effectiveAt };
    });
  }
  return { current: running, before: before };
}

/** Shapes a publication for the browser (no Date objects allowed over google.script.run). */
function serializePublication_(pub, previousMap) {
  return {
    id: pub.id,
    effectiveAt: iso_(pub.effectiveAt),
    effectiveLabel: fmtDate_(pub.effectiveAt, 'dd/MM/yy') + ' @ ' + fmtDate_(pub.effectiveAt, 'HH:mm'),
    publishedAt: iso_(pub.publishedAt),
    publishedBy: pub.publishedBy,
    note: pub.note,
    status: pub.status,
    emailStatus: pub.emailStatus,
    voidReason: pub.voidReason,
    rates: pub.rates.map(function (r) {
      var prev = previousMap ? previousMap[rateKey_(r.currency, r.category)] : null;
      return {
        currency: r.currency,
        category: r.category,
        rate: r.rate,
        previous: prev ? prev.rate : null,
        change: prev ? round2_(r.rate - prev.rate) : null
      };
    })
  };
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

/** Current rates for the dashboard: one value per active category, with change vs the previous rate. */
function getCurrent_() {
  var pubs = loadPublications_();
  var timeline = rateTimeline_(pubs);
  var active = pubs.filter(function (p) { return p.status === 'ACTIVE'; });
  var latest = active[0] || null;
  var groups = groupCategories_(getCategories_(false)).map(function (g) {
    return {
      currency: g.currency,
      displayName: g.displayName,
      lines: g.categories.map(function (cat) {
        var key = rateKey_(g.currency, cat);
        var cur = timeline.current[key];
        if (!cur) return { category: cat, rate: null, previous: null, change: null, effectiveLabel: '' };
        var prev = timeline.before[cur.pubId][key];
        return {
          category: cat,
          rate: cur.rate,
          previous: prev ? prev.rate : null,
          change: prev ? round2_(cur.rate - prev.rate) : null,
          effectiveLabel: fmtDate_(cur.effectiveAt, 'dd/MM/yy') + ' @ ' + fmtDate_(cur.effectiveAt, 'HH:mm')
        };
      })
    };
  });
  return {
    latest: latest ? serializePublication_(latest, timeline.before[latest.id]) : null,
    groups: groups,
    recent: active.slice(0, 6).map(function (p) { return serializePublication_(p, timeline.before[p.id]); })
  };
}

/** Publications between two yyyy-MM-dd dates (inclusive), newest first. */
function getHistory_(payload) {
  var from = parseDay_(payload && payload.from, false);
  var to = parseDay_(payload && payload.to, true);
  var pubs = loadPublications_();
  var timeline = rateTimeline_(pubs);
  var list = pubs.filter(function (p) {
    return (!from || p.effectiveAt >= from) && (!to || p.effectiveAt <= to);
  }).map(function (p) { return serializePublication_(p, timeline.before[p.id]); });
  return { publications: list };
}

function parseDay_(s, endOfDay) {
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) throw new AppError('Dates must be in yyyy-MM-dd format.', 'VALIDATION');
  return Utilities.parseDate(s + (endOfDay ? ' 23:59:59' : ' 00:00:00'), tz_(), 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Validates and saves a new ROE publication, then emails every active
 * subsidiary when `sendEmail` is true.
 */
function publishRates_(user, payload) {
  payload = payload || {};
  var categories = getCategories_(false);
  var allowed = {};
  categories.forEach(function (c) { allowed[rateKey_(c.currency, c.category)] = c; });

  var seen = {};
  var rates = [];
  (payload.rates || []).forEach(function (r) {
    var currency = String(r.currency || '').trim().toUpperCase();
    var category = String(r.category || '').trim();
    var raw = r.rate === null || r.rate === undefined ? '' : String(r.rate).replace(/,/g, '').trim();
    if (raw === '') return;
    var key = rateKey_(currency, category);
    if (!allowed[key]) throw new AppError('Unknown rate category: ' + currency + ' ' + category + '.', 'VALIDATION');
    if (seen[key]) throw new AppError('Duplicate rate for ' + currency + ' ' + category + '.', 'VALIDATION');
    var rate = Number(raw);
    if (!isFinite(rate) || rate <= 0 || rate >= MAX_RATE) {
      throw new AppError('Rate for ' + currency + ' ' + category + ' must be a positive number.', 'VALIDATION');
    }
    seen[key] = true;
    rates.push({ currency: currency, category: category, rate: round2_(rate), sort: allowed[key].sortOrder });
  });
  if (!rates.length) throw new AppError('Enter at least one rate.', 'VALIDATION');
  rates.sort(function (a, b) { return a.sort - b.sort; });

  var effectiveAt;
  if (payload.effectiveAt) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(payload.effectiveAt))) {
      throw new AppError('Effective date and time are not valid.', 'VALIDATION');
    }
    effectiveAt = Utilities.parseDate(String(payload.effectiveAt), tz_(), "yyyy-MM-dd'T'HH:mm");
  } else {
    effectiveAt = new Date();
  }

  var settings = getSettings_();
  var note = String(payload.note === undefined ? settings.VALIDITY_NOTE : payload.note).trim().slice(0, 500);

  var cache = CacheService.getScriptCache();
  var requestKey = payload.requestId ? 'pubreq:' + String(payload.requestId).slice(0, 64) : null;
  if (requestKey && cache.get(requestKey)) {
    throw new AppError('This publication was already submitted.', 'DUPLICATE');
  }

  var current = rateTimeline_(loadPublications_()).current;

  // Guard against typos such as 14000 instead of 1400.
  var threshold = Number(settings.LARGE_CHANGE_PERCENT) || 0;
  if (threshold > 0 && !payload.confirmLargeChange) {
    var warnings = [];
    rates.forEach(function (r) {
      var prev = current[rateKey_(r.currency, r.category)];
      if (prev && prev.rate > 0) {
        var pct = Math.abs(r.rate - prev.rate) / prev.rate * 100;
        if (pct > threshold) {
          warnings.push(r.currency + ' ' + r.category + ': ' + formatRate_(prev.rate) + ' to ' + formatRate_(r.rate) + ' (' + pct.toFixed(1) + '%)');
        }
      }
    });
    if (warnings.length) {
      throw new AppError('Some rates moved by more than ' + threshold + '%. Please confirm they are correct.', 'CONFIRM_REQUIRED', { warnings: warnings });
    }
  }

  var now = new Date();
  var id = 'ROE-' + fmtDate_(effectiveAt, 'yyyyMMdd-HHmm') + '-' + randomHex_().slice(0, 4).toUpperCase();
  var publisher = user.name + ' <' + user.email + '>';
  appendRows_(SHEETS.PUBLICATIONS, [{
    'Publication ID': id,
    'Effective At': effectiveAt,
    'Published At': now,
    'Published By': cellText_(publisher),
    'Note': cellText_(note),
    'Status': 'ACTIVE',
    'Email Status': payload.sendEmail ? 'PENDING' : 'NOT SENT'
  }]);
  appendRows_(SHEETS.ROE, rates.map(function (r) {
    return {
      'Publication ID': id,
      'Effective At': effectiveAt,
      'Currency': r.currency,
      'Category': cellText_(r.category),
      'Rate': r.rate,
      'Published By': cellText_(publisher),
      'Status': 'ACTIVE'
    };
  }));
  if (requestKey) cache.put(requestKey, id, 600);
  audit_(user.email, 'PUBLISH_ROE', {
    id: id,
    effective: fmtDate_(effectiveAt, 'dd/MM/yy HH:mm'),
    rates: rates.map(function (r) {
      var prev = current[rateKey_(r.currency, r.category)];
      var from = prev ? formatRate_(prev.rate) : 'new';
      return r.currency + ' ' + r.category + ': ' + (prev && prev.rate === r.rate ? formatRate_(r.rate) + ' (no change)' : from + ' -> ' + formatRate_(r.rate));
    })
  });

  var result = { id: id, email: null };
  if (payload.sendEmail) result.email = broadcastPublication_(id, user, 'ROE');
  return result;
}

/** Marks a publication as void. The previous rates become current again. */
function voidPublication_(user, payload) {
  var id = String((payload && payload.id) || '');
  var reason = String((payload && payload.reason) || '').trim();
  if (!reason) throw new AppError('Give a reason for voiding this publication.', 'VALIDATION');
  var pubRow = readTable_(SHEETS.PUBLICATIONS).filter(function (r) { return String(r['Publication ID']) === id; })[0];
  if (!pubRow) throw new AppError('Publication not found.', 'NOT_FOUND');
  if (String(pubRow['Status']).toUpperCase() === 'VOID') throw new AppError('This publication is already void.', 'VALIDATION');

  updateRow_(SHEETS.PUBLICATIONS, pubRow._row, {
    'Status': 'VOID',
    'Voided At': new Date(),
    'Voided By': cellText_(user.name + ' <' + user.email + '>'),
    'Void Reason': cellText_(reason.slice(0, 300))
  });
  readTable_(SHEETS.ROE).forEach(function (r) {
    if (String(r['Publication ID']) === id) updateRow_(SHEETS.ROE, r._row, { 'Status': 'VOID' });
  });
  audit_(user.email, 'VOID_ROE', { id: id, reason: reason });
  return { id: id, status: 'VOID' };
}

/** 1400 -> "1,400", 1517.02 -> "1,517.02" */
function formatRate_(n) {
  if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '';
  var num = Number(n);
  var fixed = Math.round(num * 100) % 100 === 0 ? num.toFixed(0) : num.toFixed(2);
  var parts = fixed.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

/** Book (accounting) rates from the "Rate Log" tab, newest first. Rows without a date (e.g. C/F RATE) are skipped. */
function getBookRates_() {
  var rows = readTable_(SHEETS.BOOK).filter(function (r) { return r['Effective Date'] instanceof Date; });
  rows.sort(function (a, b) { return b['Effective Date'] - a['Effective Date']; });
  return {
    entries: rows.map(function (r) {
      return {
        date: fmtDate_(r['Effective Date'], 'yyyy-MM-dd'),
        label: fmtDate_(r['Effective Date'], 'dd MMM yyyy'),
        usd: Number(r['USD']) || null,
        eur: Number(r['EUR']) || null,
        gbp: Number(r['GBP']) || null
      };
    })
  };
}

/**
 * Adds a book rate entry. EUR and GBP can be typed directly or derived from
 * the USD rate and the USD to EUR / USD to GBP cross rates, the same way the
 * "currency conv" tab does it: ROUNDDOWN(USD / cross, 2).
 */
function addBookRate_(user, payload) {
  payload = payload || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date || ''))) throw new AppError('Choose an effective date.', 'VALIDATION');
  var usd = Number(payload.usd);
  if (!isFinite(usd) || usd <= 0 || usd >= MAX_RATE) throw new AppError('Enter a valid USD rate.', 'VALIDATION');
  var eur = deriveCross_(usd, payload.eur, payload.usdToEur, 'EUR');
  var gbp = deriveCross_(usd, payload.gbp, payload.usdToGbp, 'GBP');
  var date = Utilities.parseDate(payload.date + ' 00:00:00', tz_(), 'yyyy-MM-dd HH:mm:ss');
  appendRows_(SHEETS.BOOK, [{ 'Effective Date': date, 'USD': round2_(usd), 'EUR': eur, 'GBP': gbp }]);
  audit_(user.email, 'ADD_BOOK_RATE', { date: payload.date, usd: usd, eur: eur, gbp: gbp });
  return { date: payload.date, usd: round2_(usd), eur: eur, gbp: gbp };
}

function deriveCross_(usd, direct, cross, label) {
  if (direct !== undefined && direct !== null && String(direct).trim() !== '') {
    var d = Number(direct);
    if (!isFinite(d) || d <= 0 || d >= MAX_RATE) throw new AppError('Enter a valid ' + label + ' rate.', 'VALIDATION');
    return round2_(d);
  }
  var c = Number(cross);
  if (!isFinite(c) || c <= 0 || c >= 100) throw new AppError('Enter the ' + label + ' rate or the USD to ' + label + ' cross rate.', 'VALIDATION');
  return Math.floor(usd / c * 100) / 100;
}
