/**
 * TVD OTA FareIQ :: top routes from sales, and the daily manual competitor check
 *
 * Three menu actions, run from the Pricing Config sheet by a signed-in user:
 *
 *   buildTopRoutes()         Sales sheet -> "Top Routes" tab, ranked by net fare
 *   buildCompetitorChecks()  Top routes -> "Competitor Checks" tab for today
 *   pushCompetitorChecks()   Typed prices -> tvd_fareiq_raw.offer_snapshot
 *
 * The competitor check is a person looking at each public website and typing
 * the price they see, the same as any shopper. Nothing here fetches those
 * websites. Every row lands in BigQuery with source_id 'manual_check', so it
 * can be told apart from supplier feeds and removed if ever needed.
 */

const TOP_ROUTES = {
  // The sales register. Override with the SALES_SHEET_ID script property.
  get SALES_SHEET_ID() {
    return PropertiesService.getScriptProperties().getProperty('SALES_SHEET_ID') ||
      '1-fJbZ3YPqc5ToOF3ZtlmI5B5c-V1U7j53rR8NOibNqg';
  },
  SALES_TAB_GID: 1567077370,
  SALES_TAB_NAME: 'Transactions',  // used if the tab id above is not found
  ITINERARY_COLUMN: 18,            // column R
  // "NET FARE (NGN/USD)" mixes naira and dollar rows, so the naira-normalised
  // column wins when it exists.
  NET_FARE_HEADERS: [/^\s*ngn\s*net\s*fare\s*$/i, /net\s*fare/i],
  ISSUED_FROM_HEADER: /issued\s*from/i,
  SELLING_HEADER: /^\s*ngn\s*amount\s*paid\s*$/i,
  INCOME_HEADER: /^\s*ngn\s*income\s*$/i,
  AIRLINE_HEADER: /^\s*airline\s*code\s*$/i,
  STATUS_HEADER: /^\s*transaction\s*status\s*$/i,
  PRODUCT_HEADER: /^\s*product\s*type\s*$/i,
  COUNT_STATUS: 'ISSUED',          // re-issues, voids and bookings are not new sales
  COUNT_PRODUCT: 'TICKET',         // date changes, seats and bags are not routes
  TAB: 'Top Routes',
  CHECK_TAB: 'Competitor Checks',
  CHECK_ROUTES: 8,                 // how many top routes go into the daily check
  CHECK_DAYS_OUT: [14, 30],        // departure dates checked, days from today
  CHECK_STAY_DAYS: 14,             // return date for routes sold mostly as round trips
  CHECK_CABIN: 'ECONOMY',
  POS_COUNTRY: 'NG',
  CURRENCY: 'NGN',
};

// The sites in the daily check. TravelDen's own site gives our selling price
// (seller type US); the others are competitors a customer could buy from.
const CHECK_SITES = [
  { id: 'travelden',   name: 'TravelDen',   type: 'US' },
  { id: 'wakanow',     name: 'Wakanow',     type: 'COMPETITOR_OTA' },
  { id: 'travelstart', name: 'Travelstart', type: 'COMPETITOR_OTA' },
  { id: '247travels',  name: '247Travels',  type: 'COMPETITOR_OTA' },
  { id: 'travelbeta',  name: 'Travelbeta',  type: 'COMPETITOR_OTA' },
];

// Three letter words in an itinerary that are not airports.
const NOT_AIRPORTS = ['AND', 'THE', 'VIA', 'FOR', 'RTN', 'RET', 'OUT', 'ONE', 'WAY', 'NIL', 'N/A'];

// ===================================================================
// 1. TOP ROUTES
// ===================================================================
function buildTopRoutes() {
  const src = SpreadsheetApp.openById(TOP_ROUTES.SALES_SHEET_ID);
  const tab = src.getSheets().filter(function (s) {
    return s.getSheetId() === TOP_ROUTES.SALES_TAB_GID;
  })[0] || src.getSheetByName(TOP_ROUTES.SALES_TAB_NAME) || src.getSheets()[0];
  const values = tab.getDataRange().getValues();

  // The header row is the first of the top five rows that names a net fare.
  let headerRow = -1;
  for (let i = 0; i < Math.min(5, values.length); i++) {
    if (values[i].some(function (c) { return /net\s*fare/i.test(String(c)); })) {
      headerRow = i; break;
    }
  }
  if (headerRow < 0) {
    throw new Error('Could not find a "Net fare" header in the first five rows of "' +
                    tab.getName() + '".');
  }
  const headers = values[headerRow].map(function (h) { return String(h).trim(); });
  const find = function (re) { return headers.findIndex(function (h) { return re.test(h); }); };
  let netIdx = -1;
  TOP_ROUTES.NET_FARE_HEADERS.some(function (re) { netIdx = find(re); return netIdx >= 0; });
  const issuedIdx = find(TOP_ROUTES.ISSUED_FROM_HEADER);
  const sellIdx = find(TOP_ROUTES.SELLING_HEADER);
  const incIdx = find(TOP_ROUTES.INCOME_HEADER);
  const airIdx = find(TOP_ROUTES.AIRLINE_HEADER);
  const statusIdx = find(TOP_ROUTES.STATUS_HEADER);
  const productIdx = find(TOP_ROUTES.PRODUCT_HEADER);
  const itinIdx = TOP_ROUTES.ITINERARY_COLUMN - 1;

  const routes = {};
  const unparsed = [];
  let read = 0, used = 0, issuedIsDate = false;

  for (let r = headerRow + 1; r < values.length; r++) {
    const row = values[r];
    const itin = row[itinIdx];
    if (itin === '' || itin === null) continue;
    if (statusIdx >= 0 && String(row[statusIdx]).trim().toUpperCase() !== TOP_ROUTES.COUNT_STATUS) continue;
    if (productIdx >= 0 && String(row[productIdx]).trim().toUpperCase() !== TOP_ROUTES.COUNT_PRODUCT) continue;
    read++;

    const od = parseItinerary_(itin);
    if (!od) { if (unparsed.length < 15) unparsed.push(String(itin)); continue; }
    const net = parseAmount_(row[netIdx]);
    if (net === null) continue;
    used++;

    const k = od.route_key;
    const agg = routes[k] || (routes[k] = {
      route_key: k, origin: od.origin, destination: od.destination,
      tickets: 0, net: 0, selling: 0, income: 0, round_trips: 0,
      issued: {}, airlines: {}, first: null, last: null,
    });
    agg.tickets++;
    agg.net += net;
    if (od.round_trip) agg.round_trips++;
    if (sellIdx >= 0) agg.selling += parseAmount_(row[sellIdx]) || 0;
    if (incIdx >= 0) agg.income += Number(String(row[incIdx]).replace(/[^0-9.\-]/g, '')) || 0;
    if (airIdx >= 0 && row[airIdx]) {
      const a = String(row[airIdx]).trim().toUpperCase();
      agg.airlines[a] = (agg.airlines[a] || 0) + 1;
    }

    if (issuedIdx >= 0) {
      const v = row[issuedIdx];
      if (v instanceof Date) {
        issuedIsDate = true;
        if (!agg.first || v < agg.first) agg.first = v;
        if (!agg.last || v > agg.last) agg.last = v;
      } else if (v !== '' && v !== null) {
        const key = String(v).trim();
        agg.issued[key] = (agg.issued[key] || 0) + 1;
      }
    }
  }

  const list = Object.keys(routes).map(function (k) { return routes[k]; })
    .sort(function (a, b) { return b.net - a.net; });
  const totalNet = list.reduce(function (s, x) { return s + x.net; }, 0);

  const out = getOrCreateSheet_(TOP_ROUTES.TAB);
  out.clear();
  const tz = Session.getScriptTimeZone();
  out.getRange(1, 1).setValue('Top routes by net fare, from "' + src.getName() + ' / ' +
    tab.getName() + '". Built ' + Utilities.formatDate(new Date(), tz, 'd MMM yyyy HH:mm') +
    '. Net fare from "' + headers[netIdx] + '"' +
    (statusIdx >= 0 ? ', issued tickets only' : '') + '. ' +
    read + ' rows counted, ' + used + ' used, ' +
    (read - used) + ' skipped (itinerary not understood or no net fare).');
  out.getRange(1, 1).setFontStyle('italic');

  const issuedHeader = issuedIsDate ? 'Issued between' : 'Issued from (top 3)';
  const header = ['Rank', 'Route', 'Origin', 'Destination', 'Tickets', 'Total net fare',
                  'Avg net fare', 'Share of net fare', 'Margin', 'Round trip share',
                  'Top airlines', issuedHeader];
  const rows = list.map(function (x, i) {
    let issued;
    if (issuedIsDate) {
      issued = x.first ? Utilities.formatDate(x.first, tz, 'd MMM yyyy') + ' to ' +
                         Utilities.formatDate(x.last, tz, 'd MMM yyyy') : '';
    } else {
      issued = Object.keys(x.issued)
        .sort(function (a, b) { return x.issued[b] - x.issued[a]; })
        .slice(0, 3).map(function (k) { return k + ' (' + x.issued[k] + ')'; }).join(', ');
    }
    const airlines = Object.keys(x.airlines)
      .sort(function (a, b) { return x.airlines[b] - x.airlines[a]; }).slice(0, 3).join(', ');
    return [i + 1, x.route_key, x.origin, x.destination, x.tickets, x.net,
            x.net / x.tickets, totalNet ? x.net / totalNet : 0,
            x.selling ? x.income / x.selling : '',
            x.tickets ? x.round_trips / x.tickets : 0, airlines, issued];
  });

  out.getRange(3, 1, 1, header.length).setValues([header])
     .setFontWeight('bold').setBackground('#002A48').setFontColor('#ffffff');
  if (rows.length) {
    out.getRange(4, 1, rows.length, header.length).setValues(rows);
    out.getRange(4, 6, rows.length, 2).setNumberFormat('₦#,##0');
    out.getRange(4, 8, rows.length, 3).setNumberFormat('0.0%');
  }
  out.setFrozenRows(3);
  out.autoResizeColumns(1, header.length);

  if (unparsed.length) {
    const at = 5 + rows.length;
    out.getRange(at, 1).setValue('Itineraries that could not be read (sample). ' +
      'Send one or two of these to the FareIQ team if many rows were skipped.')
      .setFontStyle('italic');
    out.getRange(at + 1, 1, unparsed.length, 1).setValues(unparsed.map(function (u) { return [u]; }));
  }

  SpreadsheetApp.getActiveSpreadsheet().toast(
    list.length + ' routes ranked from ' + used + ' tickets', 'TVD OTA FareIQ', 6);
}

/**
 * Turn an itinerary like "LOS-LHR-LOS", "LOS/IST/LHR" or "LOS LHR" into an
 * origin and destination. A round trip returns to its origin, and its
 * destination is the turnaround point in the middle of the journey. A one way
 * journey's destination is its last airport.
 */
function parseItinerary_(text) {
  const codes = (String(text).toUpperCase().match(/\b[A-Z]{3}\b/g) || [])
    .filter(function (c) { return NOT_AIRPORTS.indexOf(c) < 0; });
  if (codes.length < 2) return null;
  const origin = codes[0];
  const roundTrip = codes.length >= 3 && codes[codes.length - 1] === origin;
  const destination = roundTrip ? codes[Math.floor((codes.length - 1) / 2)] : codes[codes.length - 1];
  if (!destination || destination === origin) return null;
  return { origin: origin, destination: destination,
           route_key: origin + '-' + destination, round_trip: roundTrip };
}

/** "₦1,234,500.00", "NGN 1234500", 1234500 -> 1234500. Blank or zero -> null. */
function parseAmount_(v) {
  if (typeof v === 'number') return v > 0 ? v : null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) && n > 0 ? n : null;
}

// ===================================================================
// 2. TODAY'S COMPETITOR CHECK
// ===================================================================
function buildCompetitorChecks() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const top = ss.getSheetByName(TOP_ROUTES.TAB);
  if (!top || top.getLastRow() < 4) {
    throw new Error('Run "Build top routes from sales" first.');
  }
  const n = Math.min(TOP_ROUTES.CHECK_ROUTES, top.getLastRow() - 3);
  const topHeader = top.getRange(3, 1, 1, top.getLastColumn()).getValues()[0].map(String);
  const topRows = top.getRange(4, 1, n, topHeader.length).getValues();
  const at = function (name) { return topHeader.indexOf(name); };
  const routes = topRows.map(function (r) {
    // Routes sold mostly as round trips are checked as round trips, because
    // that is the price a customer compares.
    const rt = at('Round trip share') >= 0 ? Number(r[at('Round trip share')]) >= 0.5 : false;
    return [r[at('Route')], r[at('Origin')], r[at('Destination')], rt, r[at('Top airlines')] || ''];
  });

  const sheet = getOrCreateSheet_(TOP_ROUTES.CHECK_TAB);
  sheet.clear();
  const header = ['Route', 'Origin', 'Destination', 'Departure', 'Return (optional)', 'Cabin'];
  // Return is pre-filled for round trip routes; clear it to check one way.
  CHECK_SITES.forEach(function (s) {
    header.push(s.name + ' price', s.name + ' bag incl. (Y/N)');
  });
  header.push('Airline (optional)', 'Checked by', 'Checked at', 'Notes', 'Sent to FareIQ');

  const today = new Date();
  const rows = [];
  routes.forEach(function (r) {
    TOP_ROUTES.CHECK_DAYS_OUT.forEach(function (days) {
      const dep = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
      const ret = r[3] ? new Date(dep.getFullYear(), dep.getMonth(),
                                  dep.getDate() + TOP_ROUTES.CHECK_STAY_DAYS) : '';
      const row = [r[0], r[1], r[2], dep, ret, TOP_ROUTES.CHECK_CABIN];
      CHECK_SITES.forEach(function () { row.push('', ''); });
      row.push('', '', '', 'Usual airlines: ' + r[4], '');
      rows.push(row);
    });
  });

  sheet.getRange(1, 1, 1, header.length).setValues([header])
       .setFontWeight('bold').setBackground('#002A48').setFontColor('#ffffff').setWrap(true);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
    sheet.getRange(2, 4, rows.length, 2).setNumberFormat('ddd d mmm yyyy');
    CHECK_SITES.forEach(function (s, i) {
      const col = 7 + i * 2;
      sheet.getRange(2, col, rows.length, 1).setNumberFormat('₦#,##0').setBackground('#FFF8E6');
      sheet.getRange(2, col + 1, rows.length, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(['Y', 'N'], true).build());
    });
  }
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(4);
  sheet.autoResizeColumns(1, 6);

  ss.toast('Search each site for the route and dates on the row (round trip when a return ' +
           'date is shown), one adult, economy, and type the cheapest total price shown. Then use "Send competitor checks to FareIQ".',
           'TVD OTA FareIQ', 12);
}

// ===================================================================
// 3. SEND THE CHECKS TO FAREIQ
// ===================================================================
function pushCompetitorChecks() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TOP_ROUTES.CHECK_TAB);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('No competitor checks to send.');

  const values = sheet.getDataRange().getValues();
  const header = values[0].map(String);
  const col = function (name) { return header.indexOf(name); };
  const sentCol = col('Sent to FareIQ');
  const project = CONFIG.PROJECT_ID || 'tvd-fareiq-prod';
  const user = Session.getActiveUser().getEmail();
  const tz = 'Africa/Lagos';
  const now = new Date();
  const runId = 'manual_' + Utilities.formatDate(now, 'UTC', 'yyyyMMddHHmmss');

  const rows = [];
  const sentRows = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v[sentCol]) continue;                       // already sent
    const dep = v[col('Departure')];
    if (!(dep instanceof Date)) continue;
    const ret = v[col('Return (optional)')];
    const checkedAt = v[col('Checked at')] instanceof Date ? v[col('Checked at')] : now;
    let any = false;

    CHECK_SITES.forEach(function (s) {
      const price = parseAmount_(v[col(s.name + ' price')]);
      if (price === null) return;
      any = true;
      const bag = String(v[col(s.name + ' bag incl. (Y/N)')] || '').toUpperCase();
      const id = Utilities.getUuid().replace(/-/g, '');
      rows.push({ insertId: id, json: {
        snapshot_id: id,
        collection_run_id: runId,
        source_id: 'manual_check',
        source_tier: 'PERMITTED_PUBLIC',
        collected_at: checkedAt.toISOString(),
        ingested_at: now.toISOString(),
        request_origin: String(v[col('Origin')]).trim().toUpperCase(),
        request_destination: String(v[col('Destination')]).trim().toUpperCase(),
        request_departure_date: Utilities.formatDate(dep, tz, 'yyyy-MM-dd'),
        request_return_date: ret instanceof Date ? Utilities.formatDate(ret, tz, 'yyyy-MM-dd') : null,
        request_trip_type: ret instanceof Date ? 'ROUND_TRIP' : 'ONE_WAY',
        request_cabin: String(v[col('Cabin')] || TOP_ROUTES.CHECK_CABIN).toUpperCase(),
        request_pax_adults: 1,
        request_pax_children: 0,
        request_pax_infants: 0,
        request_pos_country: TOP_ROUTES.POS_COUNTRY,
        request_currency: TOP_ROUTES.CURRENCY,
        seller_type: s.type,
        seller_id: s.id,
        marketing_carrier: String(v[col('Airline (optional)')] || '').trim().toUpperCase() || null,
        quote_currency: TOP_ROUTES.CURRENCY,
        displayed_total: String(price),
        included_checked_bags: bag === 'Y' ? 1 : (bag === 'N' ? 0 : null),
        availability_status: 'AVAILABLE',
        legal_basis: 'PERMITTED_PUBLIC',
        raw_payload: JSON.stringify({
          method: 'manual_check', site: s.id,
          checked_by: String(v[col('Checked by')] || user), notes: String(v[col('Notes')] || ''),
        }),
      }});
    });
    if (any) sentRows.push(i + 1);
  }

  if (!rows.length) {
    ss.toast('Nothing new to send. Type prices in the yellow columns first.', 'TVD OTA FareIQ', 6);
    return;
  }

  const resp = BigQuery.Tabledata.insertAll({ rows: rows, skipInvalidRows: false },
                                            project, 'tvd_fareiq_raw', 'offer_snapshot');
  if (resp.insertErrors && resp.insertErrors.length) {
    const first = resp.insertErrors[0];
    throw new Error('BigQuery refused the prices: ' + JSON.stringify(first.errors).slice(0, 300));
  }

  const stamp = Utilities.formatDate(now, tz, 'd MMM yyyy HH:mm') + ' by ' + user;
  sentRows.forEach(function (r) { sheet.getRange(r, sentCol + 1).setValue(stamp); });
  ss.toast(rows.length + ' prices from ' + sentRows.length + ' rows sent to FareIQ. ' +
           'They appear in the dashboard after the next transform run.', 'TVD OTA FareIQ', 8);
}
