/**
 * TVD OTA FareIQ :: Google Workspace layer
 *
 * Three jobs, and deliberately nothing more. Apps Script is the interface,
 * never the engine: no pricing logic lives here.
 *
 *   1. syncConfigToBigQuery()   Sheet -> dim_route, dim_pricing_rule, dim_seller
 *   2. pullDailyReview()        BigQuery -> the Daily Review sheet
 *   3. submitDecisions()        approvals -> the pricing service audit endpoint
 *   plus sendMorningDigest()    the 07:00 Gmail brief
 *
 * Auth: the script runs as a dedicated Workspace service identity with
 * BigQuery Data Viewer on tvd_fareiq_mart and Cloud Run Invoker on the pricing
 * service. It has no write access to BigQuery at all: every write goes
 * through the service so it lands in the audit trail.
 */

const CONFIG = {
  PROJECT_ID: PropertiesService.getScriptProperties().getProperty('GCP_PROJECT'),
  PRICING_SERVICE_URL: PropertiesService.getScriptProperties().getProperty('PRICING_SERVICE_URL'),
  BQ_LOCATION: 'europe-west2',
  SHEETS: {
    ROUTES: 'Routes',
    RULES: 'Pricing Rules',
    SELLERS: 'Competitors',
    REVIEW: 'Daily Review',
    FEES: 'Fee Watch',
    LOG: 'Sync Log'
  },
  DIGEST_RECIPIENTS: PropertiesService.getScriptProperties().getProperty('DIGEST_RECIPIENTS'),
  // Copied on the morning digest. Comma separated.
  DIGEST_CC: PropertiesService.getScriptProperties().getProperty('DIGEST_CC') || '',
  MAX_REVIEW_ROWS: 300
};

// ===================================================================
// MENU
// ===================================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('TVD OTA FareIQ')
    .addItem('Pull today\'s review', 'pullDailyReview')
    .addItem('Submit decisions', 'submitDecisions')
    .addSeparator()
    .addItem('Push config to BigQuery', 'syncConfigToBigQuery')
    .addItem('Send morning digest now', 'sendMorningDigest')
    .addSeparator()
    .addItem('Build top routes from sales', 'buildTopRoutes')
    .addItem('Create today\'s competitor check', 'buildCompetitorChecks')
    .addItem('Send competitor checks to FareIQ', 'pushCompetitorChecks')
    .addItem('Sync bookings from sales register', 'syncBookingsToFareIQ')
    .addToUi();
}

// ===================================================================
// 1. CONFIG SYNC  (Sheet is the editing surface, BigQuery is the record)
// ===================================================================
function syncConfigToBigQuery() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const results = [];

  results.push(pushTable_(ss, CONFIG.SHEETS.ROUTES, 'dim_route', validateRoute_));
  results.push(pushTable_(ss, CONFIG.SHEETS.RULES, 'dim_pricing_rule', validateRule_));
  results.push(pushTable_(ss, CONFIG.SHEETS.SELLERS, 'dim_seller', validateSeller_));

  logSync_(ss, results);
  SpreadsheetApp.getUi().alert('Config sync complete:\n\n' + results.map(function (r) {
    return r.table + ': ' + r.rows + ' rows, ' + r.errors.length + ' rejected';
  }).join('\n'));
}

function pushTable_(ss, sheetName, table, validator) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { table: table, rows: 0, errors: ['sheet missing: ' + sheetName] };

  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(function (h) { return String(h).trim(); });

  const rows = [];
  const errors = [];
  values.forEach(function (row, i) {
    if (row.every(function (c) { return c === '' || c === null; })) return;
    const obj = {};
    headers.forEach(function (h, j) { if (h) obj[h] = row[j]; });
    const problem = validator(obj);
    if (problem) {
      errors.push('row ' + (i + 2) + ': ' + problem);
      return;
    }
    obj.updated_at = new Date().toISOString();
    rows.push(obj);
  });

  if (rows.length) {
    // Truncate and reload. The Sheet is authoritative for configuration, and
    // dim_pricing_rule keeps its own effective_from/to history so nothing is lost.
    const sql = buildMergeSql_(table, rows);
    runQuery_(sql);
  }
  return { table: table, rows: rows.length, errors: errors };
}

function validateRoute_(r) {
  if (!r.route_key || !/^[A-Z]{3}-[A-Z]{3}$/.test(String(r.route_key).trim())) {
    return 'route_key must look like LOS-LHR';
  }
  if (r.min_margin_pct_floor !== '' && (r.min_margin_pct_floor < 0 || r.min_margin_pct_floor > 0.5)) {
    return 'min_margin_pct_floor must be between 0 and 0.5';
  }
  if (['T1', 'T2', 'T3'].indexOf(String(r.monitoring_tier)) === -1) {
    return 'monitoring_tier must be T1, T2 or T3';
  }
  return null;
}

function validateRule_(r) {
  if (!r.rule_id) return 'rule_id required';
  const scopes = ['GLOBAL', 'REGION', 'ROUTE', 'CARRIER', 'ROUTE_CARRIER', 'CABIN'];
  if (scopes.indexOf(String(r.scope_type)) === -1) return 'invalid scope_type';
  if (r.min_margin_pct !== '' && r.target_margin_pct !== '' &&
      Number(r.target_margin_pct) < Number(r.min_margin_pct)) {
    return 'target_margin_pct below min_margin_pct';
  }
  if (r.max_daily_move_pct !== '' && Number(r.max_daily_move_pct) > 0.25) {
    return 'max_daily_move_pct above 0.25 is not permitted without commercial sign off';
  }
  return null;
}

function validateSeller_(r) {
  if (!r.seller_id) return 'seller_id required';
  if (r.benchmark_weight !== '' && (Number(r.benchmark_weight) < 0 || Number(r.benchmark_weight) > 5)) {
    return 'benchmark_weight must be between 0 and 5';
  }
  return null;
}

// ===================================================================
// 2. PULL THE DAILY REVIEW
// ===================================================================
function pullDailyReview() {
  const sql =
    'SELECT recommendation_id, route_key, origin_city, destination_city, marketing_carrier, ' +
    '       departure_date, cabin, days_to_departure, our_price, our_true_customer_cost, ' +
    '       cheapest_competitor, cheapest_competitor_price, market_median, price_gap, ' +
    '       price_gap_pct, price_index, our_market_rank, panel_size, current_margin_pct, ' +
    '       minimum_price, recommended_price, price_change_pct, classification, action, ' +
    '       priority, confidence, expected_revenue_impact, expected_margin_impact, rationale ' +
    'FROM `' + CONFIG.PROJECT_ID + '.tvd_fareiq_mart.v_daily_pricing_review` ' +
    'WHERE review_date = CURRENT_DATE() AND status = "PENDING" ' +
    'ORDER BY CASE priority WHEN "P1" THEN 1 WHEN "P2" THEN 2 ELSE 3 END, ' +
    '         ABS(expected_margin_impact) DESC ' +
    'LIMIT ' + CONFIG.MAX_REVIEW_ROWS;

  const result = runQuery_(sql);
  const sheet = getOrCreateSheet_(CONFIG.SHEETS.REVIEW);
  sheet.clear();

  const headers = result.schema.fields.map(function (f) { return f.name; })
    .concat(['DECISION', 'APPROVED_PRICE', 'OVERRIDE_REASON', 'SUBMITTED']);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
       .setFontWeight('bold').setBackground('#0b3d2e').setFontColor('#ffffff');

  const rows = (result.rows || []).map(function (r) {
    return r.f.map(function (c) { return c.v; }).concat(['', '', '', '']);
  });

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    applyReviewFormatting_(sheet, rows.length, headers);
  }
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  SpreadsheetApp.getActiveSpreadsheet().toast(rows.length + ' recommendations loaded', 'TVD OTA FareIQ', 5);
}

function applyReviewFormatting_(sheet, n, headers) {
  const col = function (name) { return headers.indexOf(name) + 1; };

  // Decision dropdown
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['APPROVE', 'REJECT', 'MODIFY', 'DEFER'], true).build();
  sheet.getRange(2, col('DECISION'), n, 1).setDataValidation(rule);

  // Priority colouring
  const pr = sheet.getRange(2, col('priority'), n, 1);
  pr.setConditionalFormatRules([]);
  const rules = [
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('P1')
      .setBackground('#c0392b').setFontColor('#ffffff').setRanges([pr]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('P2')
      .setBackground('#e67e22').setFontColor('#ffffff').setRanges([pr]).build()
  ];

  // Classification colouring
  const cl = sheet.getRange(2, col('classification'), n, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('UNCOMPETITIVE')
    .setBackground('#f9d0c4').setRanges([cl]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('MARGIN_OPPORTUNITY')
    .setBackground('#c6f6d5').setRanges([cl]).build());

  // Low confidence warning
  const cf = sheet.getRange(2, col('confidence'), n, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0.6)
    .setBackground('#fff3cd').setRanges([cf]).build());

  sheet.setConditionalFormatRules(rules);
  sheet.getRange(2, col('our_price'), n, 1).setNumberFormat('#,##0');
  sheet.getRange(2, col('recommended_price'), n, 1).setNumberFormat('#,##0');
  sheet.getRange(2, col('price_index'), n, 1).setNumberFormat('0.000');
  sheet.autoResizeColumns(1, 6);
}

// ===================================================================
// 3. SUBMIT DECISIONS
// ===================================================================
function submitDecisions() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.REVIEW);
  const values = sheet.getDataRange().getValues();
  const headers = values.shift();
  const idx = function (name) { return headers.indexOf(name); };

  const user = Session.getActiveUser().getEmail();
  let sent = 0;
  const failures = [];

  values.forEach(function (row, i) {
    const decision = String(row[idx('DECISION')] || '').trim().toUpperCase();
    const already = String(row[idx('SUBMITTED')] || '').trim();
    if (!decision || already) return;

    const map = { APPROVE: 'APPROVED', REJECT: 'REJECTED', MODIFY: 'MODIFIED', DEFER: 'DEFERRED' };
    const payload = {
      recommendation_id: row[idx('recommendation_id')],
      decision: map[decision],
      approved_price: decision === 'MODIFY' ? Number(row[idx('APPROVED_PRICE')]) : null,
      override_reason: String(row[idx('OVERRIDE_REASON')] || '') || null,
      decided_by: user,
      decision_channel: 'SHEET'
    };

    if ((decision === 'MODIFY' || decision === 'REJECT') && !payload.override_reason) {
      failures.push('Row ' + (i + 2) + ': a reason is required to ' + decision.toLowerCase());
      return;
    }

    try {
      const resp = UrlFetchApp.fetch(CONFIG.PRICING_SERVICE_URL + '/decision', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + ScriptApp.getIdentityToken() },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 200) {
        sheet.getRange(i + 2, idx('SUBMITTED') + 1).setValue(new Date());
        sent++;
      } else {
        failures.push('Row ' + (i + 2) + ': ' + resp.getContentText().slice(0, 180));
      }
    } catch (e) {
      failures.push('Row ' + (i + 2) + ': ' + e.message);
    }
  });

  const msg = sent + ' decisions recorded.' +
    (failures.length ? '\n\nNot recorded:\n' + failures.join('\n') : '');
  SpreadsheetApp.getUi().alert(msg);
}

// ===================================================================
// 4. MORNING DIGEST
// ===================================================================
function sendMorningDigest() {
  const exec = runQuery_('SELECT * FROM `' + CONFIG.PROJECT_ID + '.tvd_fareiq_mart.v_exec_overview`');
  const top = runQuery_(
    'SELECT route_key, IF(trip_type = "ROUND_TRIP", "Return", "One way") AS trip, ' +
    '       departure_date, cabin, action, priority, our_price, ' +
    '       cheapest_competitor_price, price_index, recommended_price, ' +
    '       expected_margin_impact, confidence, rationale ' +
    'FROM `' + CONFIG.PROJECT_ID + '.tvd_fareiq_mart.v_daily_pricing_review` ' +
    'WHERE review_date = CURRENT_DATE() AND action != "HOLD" ' +
    'ORDER BY CASE priority WHEN "P1" THEN 1 WHEN "P2" THEN 2 ELSE 3 END, ' +
    '         ABS(expected_margin_impact) DESC LIMIT 15');
  const fees = runQuery_(
    'SELECT carrier, fee_type, previous_amount, new_amount, change_pct, currency ' +
    'FROM `' + CONFIG.PROJECT_ID + '.tvd_fareiq_mart.v_airline_fee_changes` ' +
    'WHERE change_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) ' +
    'ORDER BY ABS(change_pct) DESC LIMIT 10');
  const moves = runQuery_(
    'SELECT seller_id, route_key, prev_median_price, median_price, change_pct ' +
    'FROM `' + CONFIG.PROJECT_ID + '.tvd_fareiq_mart.v_competitor_movements` ' +
    'WHERE obs_date = CURRENT_DATE() AND movement_band = "MAJOR" ' +
    'ORDER BY ABS(change_pct) DESC LIMIT 10');

  const html = buildDigestHtml_(exec, top, fees, moves);
  MailApp.sendEmail({
    to: CONFIG.DIGEST_RECIPIENTS,
    cc: CONFIG.DIGEST_CC,
    subject: 'TVD OTA FareIQ pricing review :: ' + Utilities.formatDate(new Date(), 'Africa/Lagos', 'EEE d MMM yyyy'),
    htmlBody: html,
    noReply: true
  });
}

function buildDigestHtml_(exec, top, fees, moves) {
  const e = exec.rows && exec.rows[0] ? exec.rows[0].f.map(function (c) { return c.v; }) : [];
  const f = exec.schema.fields.map(function (x) { return x.name; });
  const get = function (name) { const i = f.indexOf(name); return i >= 0 ? e[i] : '-'; };

  let html = '<div style="font-family:Inter,Arial,sans-serif;max-width:760px;color:#14281d">';
  html += '<h2 style="margin:0 0 4px">Pricing review</h2>';
  html += '<p style="color:#5b6b60;margin:0 0 18px">' +
          Utilities.formatDate(new Date(), 'Africa/Lagos', 'EEEE d MMMM yyyy') + '</p>';

  html += '<table style="width:100%;border-collapse:collapse;margin-bottom:20px"><tr>';
  [['Routes', get('routes_monitored')], ['Price index', get('avg_price_index')],
   ['P1 actions', get('p1_actions')], ['Margin upside', fmtMoney_(get('margin_upside_base_ccy'))]]
    .forEach(function (kv) {
      html += '<td style="padding:12px;background:#f2f6f3;border-radius:8px;width:25%">' +
              '<div style="font-size:11px;color:#5b6b60;text-transform:uppercase;letter-spacing:.5px">' + kv[0] + '</div>' +
              '<div style="font-size:22px;font-weight:600">' + kv[1] + '</div></td><td style="width:8px"></td>';
    });
  html += '</tr></table>';

  html += section_('Recommended price changes', top,
    ['route_key', 'trip', 'departure_date', 'action', 'priority', 'our_price',
     'cheapest_competitor_price', 'recommended_price', 'expected_margin_impact', 'confidence']);
  html += section_('Airline fee changes', fees,
    ['carrier', 'fee_type', 'previous_amount', 'new_amount', 'change_pct']);
  html += section_('Major competitor movements', moves,
    ['seller_id', 'route_key', 'prev_median_price', 'median_price', 'change_pct']);

  html += '<p style="font-size:12px;color:#5b6b60;margin-top:24px">' +
          'Recommendations are decision support. Nothing changes until a pricing analyst approves it in the ' +
          '<a href="' + SpreadsheetApp.getActiveSpreadsheet().getUrl() + '">Daily Review sheet</a>.</p></div>';
  return html;
}

function section_(title, result, cols) {
  if (!result.rows || !result.rows.length) {
    return '<h3 style="margin:20px 0 6px;font-size:15px">' + title +
           '</h3><p style="color:#5b6b60;font-size:13px;margin:0">Nothing to report.</p>';
  }
  const names = result.schema.fields.map(function (x) { return x.name; });
  let html = '<h3 style="margin:22px 0 8px;font-size:15px">' + title + '</h3>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:13px">';
  html += '<tr>' + cols.map(function (c) {
    return '<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #cfe0d5;font-size:11px;' +
           'text-transform:uppercase;letter-spacing:.4px;color:#5b6b60">' + c.replace(/_/g, ' ') + '</th>';
  }).join('') + '</tr>';
  result.rows.forEach(function (r) {
    html += '<tr>' + cols.map(function (c) {
      const i = names.indexOf(c);
      return '<td style="padding:6px 8px;border-bottom:1px solid #eef3ef">' +
             (i >= 0 ? (r.f[i].v === null ? '-' : r.f[i].v) : '-') + '</td>';
    }).join('') + '</tr>';
  });
  return html + '</table>';
}

function fmtMoney_(v) {
  const n = Number(v);
  return isNaN(n) ? '-' : '₦' + n.toLocaleString('en-NG', { maximumFractionDigits: 0 });
}

// ===================================================================
// HELPERS
// ===================================================================
function runQuery_(sql) {
  const request = {
    query: sql,
    useLegacySql: false,
    location: CONFIG.BQ_LOCATION,
    maximumBytesBilled: '2000000000'   // 2 GB guard. A runaway query should fail, not bill.
  };
  let job = BigQuery.Jobs.query(request, CONFIG.PROJECT_ID);
  let attempts = 0;
  while (!job.jobComplete && attempts < 30) {
    Utilities.sleep(1500);
    job = BigQuery.Jobs.getQueryResults(CONFIG.PROJECT_ID, job.jobReference.jobId,
                                        { location: CONFIG.BQ_LOCATION });
    attempts++;
  }
  if (!job.jobComplete) throw new Error('BigQuery query timed out');
  return job;
}

function buildMergeSql_(table, rows) {
  const cols = Object.keys(rows[0]);
  const values = rows.map(function (r) {
    return '(' + cols.map(function (c) { return sqlLiteral_(r[c]); }).join(',') + ')';
  }).join(',');
  const keys = { dim_route: 'route_key', dim_pricing_rule: 'rule_id', dim_seller: 'seller_id' };
  const key = keys[table];
  return 'MERGE `' + CONFIG.PROJECT_ID + '.tvd_fareiq_mart.' + table + '` T ' +
         'USING (SELECT * FROM UNNEST([STRUCT<' +
         cols.map(function (c) { return c + ' STRING'; }).join(',') +
         '>' + values + '])) S ON T.' + key + ' = S.' + key + ' ' +
         'WHEN MATCHED THEN UPDATE SET ' +
         cols.filter(function (c) { return c !== key; })
             .map(function (c) { return c + ' = S.' + c; }).join(',') + ' ' +
         'WHEN NOT MATCHED THEN INSERT ROW';
}

function sqlLiteral_(v) {
  if (v === '' || v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return '"' + v.toISOString() + '"';
  return '"' + String(v).replace(/"/g, '\\"') + '"';
}

function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function logSync_(ss, results) {
  const sheet = getOrCreateSheet_(CONFIG.SHEETS.LOG);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['timestamp', 'user', 'table', 'rows', 'errors']);
  }
  results.forEach(function (r) {
    sheet.appendRow([new Date(), Session.getActiveUser().getEmail(),
                     r.table, r.rows, r.errors.join(' | ')]);
  });
}

// ===================================================================
// TIME DRIVEN TRIGGERS (install once)
// ===================================================================
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  // 05:00 real bookings in, 05:30 transform (Cloud Scheduler), then the review.
  ScriptApp.newTrigger('syncBookingsToFareIQ').timeBased().atHour(5).nearMinute(0).everyDays(1).create();
  ScriptApp.newTrigger('pullDailyReview').timeBased().atHour(6).nearMinute(45).everyDays(1).create();
  ScriptApp.newTrigger('sendMorningDigest').timeBased().atHour(7).nearMinute(0).everyDays(1).create();
}
