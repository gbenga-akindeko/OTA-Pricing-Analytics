/**
 * TVD OTA FareIQ :: daily Skyscanner check for the top 20 routes
 *
 * Two menu actions:
 *
 *   buildSkyscannerChecks()  Top Routes -> "Skyscanner Checks" tab for today
 *   pushSkyscannerChecks()   Typed prices -> tvd_fareiq_raw.offer_snapshot
 *
 * A person opens each row's Skyscanner link, reads the results the way any
 * shopper would, and types the three cheapest offers: price, who sells it
 * (an OTA or the airline itself) and the airline flown. Nothing here fetches
 * Skyscanner. Rows land with source_id 'manual_skyscanner', so they can be
 * told apart from the website check ('manual_check') and from supplier feeds.
 *
 * Set Skyscanner to Nigeria / Naira (the flag at the top of the page) before
 * checking, so every price is in naira and from the Nigerian market, the
 * same point of sale TravelDen prices for.
 */

const SKYSCANNER = {
  TAB: 'Skyscanner Checks',
  ROUTES: 20,                       // top routes from the Top Routes tab
  INCLUDE_PRIORITY_ROUTES: true,    // also the new routes in TOP_ROUTES.PRIORITY_ROUTES
  DAYS_OUT: [14, 30],               // departure dates checked, days from today
  STAY_DAYS: 14,                    // return date for routes sold mostly as round trips
  CABIN: 'ECONOMY',
  OFFERS: 3,                        // cheapest offers typed per row
  SOURCE_ID: 'manual_skyscanner',
};

// Seller names as Skyscanner shows them. Known names map to the seller ids
// already used elsewhere, so Wakanow on Skyscanner and Wakanow on its own site
// are one competitor. Any other name typed is accepted and becomes a new
// competitor OTA; an airline name becomes that airline selling direct.
const SKY_OTAS = {
  'TravelDen': { id: 'travelden', type: 'US' },
  'Wakanow': { id: 'wakanow', type: 'COMPETITOR_OTA' },
  'Travelstart': { id: 'travelstart', type: 'COMPETITOR_OTA' },
  '247Travels': { id: '247travels', type: 'COMPETITOR_OTA' },
  'Travelbeta': { id: 'travelbeta', type: 'COMPETITOR_OTA' },
  'Trip.com': { id: 'trip_com', type: 'COMPETITOR_OTA' },
  'Kiwi.com': { id: 'kiwi_com', type: 'COMPETITOR_OTA' },
  'Mytrip': { id: 'mytrip', type: 'COMPETITOR_OTA' },
  'Gotogate': { id: 'gotogate', type: 'COMPETITOR_OTA' },
  'eDreams': { id: 'edreams', type: 'COMPETITOR_OTA' },
  'Opodo': { id: 'opodo', type: 'COMPETITOR_OTA' },
  'Expedia': { id: 'expedia', type: 'COMPETITOR_OTA' },
  'Booking.com': { id: 'booking_com', type: 'COMPETITOR_OTA' },
  'Travelwings': { id: 'travelwings', type: 'COMPETITOR_OTA' },
  'Lastminute.com': { id: 'lastminute', type: 'COMPETITOR_OTA' },
};

const SKY_AIRLINES = {
  'Air Peace': 'P4', 'British Airways': 'BA', 'Virgin Atlantic': 'VS',
  'Qatar Airways': 'QR', 'Emirates': 'EK', 'Turkish Airlines': 'TK',
  'Ethiopian Airlines': 'ET', 'Kenya Airways': 'KQ', 'RwandAir': 'WB',
  'Air France': 'AF', 'KLM': 'KL', 'Delta': 'DL', 'United Airlines': 'UA',
  'Lufthansa': 'LH', 'EgyptAir': 'MS', 'Royal Air Maroc': 'AT',
  'Air Canada': 'AC', 'China Southern': 'CZ', 'Saudia': 'SV',
  'Africa World Airlines': 'AW', 'ASKY Airlines': 'KP', 'Ibom Air': 'QI',
  'United Nigeria Airlines': 'UN', 'ValueJet': 'VK', 'Arik Air': 'W3',
};

// ===================================================================
// 1. BUILD TODAY'S SKYSCANNER CHECK
// ===================================================================
function buildSkyscannerChecks() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const top = ss.getSheetByName(TOP_ROUTES.TAB);
  if (!top || top.getLastRow() < 4) {
    throw new Error('Run "Build top routes from sales" first.');
  }
  const n = Math.min(SKYSCANNER.ROUTES, top.getLastRow() - 3);
  const topHeader = top.getRange(3, 1, 1, top.getLastColumn()).getValues()[0].map(String);
  const topRows = top.getRange(4, 1, n, topHeader.length).getValues();
  const at = function (name) { return topHeader.indexOf(name); };
  const routes = topRows.map(function (r) {
    const rt = at('Round trip share') >= 0 ? Number(r[at('Round trip share')]) >= 0.5 : false;
    return { key: String(r[at('Route')]), o: String(r[at('Origin')]), d: String(r[at('Destination')]),
             rt: rt, airlines: r[at('Top airlines')] || '' };
  }).filter(function (r) { return r.o && r.d; });
  if (SKYSCANNER.INCLUDE_PRIORITY_ROUTES) {
    const listed = routes.map(function (r) { return r.key; });
    TOP_ROUTES.PRIORITY_ROUTES.forEach(function (key) {
      if (listed.indexOf(key) >= 0) return;
      const od = key.split('-');
      routes.push({ key: key, o: od[0], d: od[1], rt: true, airlines: 'new route' });
    });
  }

  // FareIQ can only compare a Skyscanner price with ours on a route it
  // monitors, so any top 20 route not yet in dim_route is added to it.
  registerRoutes_(CONFIG.PROJECT_ID || 'tvd-fareiq-prod', routes);

  const header = ['Route', 'Origin', 'Destination', 'Trip', 'Departure', 'Return', 'Cabin',
                  'Skyscanner link'];
  for (let k = 1; k <= SKYSCANNER.OFFERS; k++) {
    header.push('#' + k + ' price (₦)', '#' + k + ' sold by', '#' + k + ' airline', '#' + k + ' stops');
  }
  header.push('TravelDen on Skyscanner (₦)', 'Checked by', 'Notes', 'Sent to FareIQ');

  const today = new Date();
  const rows = [];
  routes.forEach(function (r) {
    SKYSCANNER.DAYS_OUT.forEach(function (days) {
      const dep = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
      const ret = r.rt ? new Date(dep.getFullYear(), dep.getMonth(), dep.getDate() + SKYSCANNER.STAY_DAYS) : '';
      const row = [r.key, r.o, r.d, r.rt ? 'Return' : 'One way', dep, ret, SKYSCANNER.CABIN,
                   skyscannerLink_(r.o, r.d, dep, ret || null, SKYSCANNER.CABIN)];
      for (let k = 0; k < SKYSCANNER.OFFERS; k++) row.push('', '', '', '');
      row.push('', '', 'Usual airlines: ' + r.airlines, '');
      rows.push(row);
    });
  });

  const sheet = getOrCreateSheet_(SKYSCANNER.TAB);
  sheet.clear();
  sheet.getRange(1, 1, 1, header.length).setValues([header])
       .setFontWeight('bold').setBackground('#002A48').setFontColor('#ffffff').setWrap(true);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
    sheet.getRange(2, 5, rows.length, 2).setNumberFormat('ddd d mmm yyyy');

    const sellerRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(Object.keys(SKY_OTAS).concat(Object.keys(SKY_AIRLINES)), true)
      .setAllowInvalid(true)            // any other seller name can be typed
      .build();
    const airlineRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(Object.keys(SKY_AIRLINES), true)
      .setAllowInvalid(true)            // or a two letter code, e.g. BA
      .build();
    const stopsRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['0', '1', '2', '3'], true).setAllowInvalid(false).build();
    for (let k = 0; k < SKYSCANNER.OFFERS; k++) {
      const c = 9 + k * 4;
      sheet.getRange(2, c, rows.length, 1).setNumberFormat('₦#,##0').setBackground('#FFF8E6');
      sheet.getRange(2, c + 1, rows.length, 1).setDataValidation(sellerRule);
      sheet.getRange(2, c + 2, rows.length, 1).setDataValidation(airlineRule);
      sheet.getRange(2, c + 3, rows.length, 1).setDataValidation(stopsRule);
    }
    sheet.getRange(2, 9 + SKYSCANNER.OFFERS * 4, rows.length, 1)
         .setNumberFormat('₦#,##0').setBackground('#E8F5EE');
  }
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(4);
  sheet.autoResizeColumns(1, 7);

  ss.toast(rows.length + ' rows ready. Set Skyscanner to Nigeria / Naira first. Open each link, ' +
           'sort by Cheapest, and type the three cheapest offers: price, who sells it, airline ' +
           'and stops. Then use "Send Skyscanner checks to FareIQ".', 'TVD OTA FareIQ', 15);
}

/** Skyscanner search URL: /transport/flights/los/lhr/261018/261101/ */
function skyscannerLink_(origin, destination, dep, ret, cabin) {
  const d = function (x) { return Utilities.formatDate(x, 'Africa/Lagos', 'yyMMdd'); };
  const cabinParam = { ECONOMY: 'economy', PREMIUM_ECONOMY: 'premiumeconomy',
                       BUSINESS: 'business', FIRST: 'first' }[cabin] || 'economy';
  const url = 'https://www.skyscanner.net/transport/flights/' +
    origin.toLowerCase() + '/' + destination.toLowerCase() + '/' + d(dep) + '/' +
    (ret ? d(ret) + '/' : '') +
    '?adultsv2=1&cabinclass=' + cabinParam + '&rtn=' + (ret ? 1 : 0) + '&preferdirects=false';
  return '=HYPERLINK("' + url + '","Open")';
}

// ===================================================================
// 2. SEND THE SKYSCANNER CHECKS TO FAREIQ
// ===================================================================
function pushSkyscannerChecks() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SKYSCANNER.TAB);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('No Skyscanner checks to send.');

  const values = sheet.getDataRange().getValues();
  const header = values[0].map(String);
  const col = function (name) { return header.indexOf(name); };
  const sentCol = col('Sent to FareIQ');
  const project = CONFIG.PROJECT_ID || 'tvd-fareiq-prod';
  const user = Session.getActiveUser().getEmail();
  const tz = 'Africa/Lagos';
  // Stamped with the send time, not the time typed: the transform picks up
  // the last two hours of rows, and the snapshot then carries manual prices
  // for 24 hours.
  const now = new Date();
  const runId = 'skyscanner_' + Utilities.formatDate(now, 'UTC', 'yyyyMMddHHmmss');

  const rows = [];
  const sentRows = [];
  const sellers = {};
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v[sentCol]) continue;
    const dep = v[col('Departure')];
    if (!(dep instanceof Date)) continue;
    const ret = v[col('Return')];
    const base = {
      origin: String(v[col('Origin')]).trim().toUpperCase(),
      destination: String(v[col('Destination')]).trim().toUpperCase(),
      dep: Utilities.formatDate(dep, tz, 'yyyy-MM-dd'),
      ret: ret instanceof Date ? Utilities.formatDate(ret, tz, 'yyyy-MM-dd') : null,
      cabin: String(v[col('Cabin')] || SKYSCANNER.CABIN).toUpperCase(),
      checkedBy: String(v[col('Checked by')] || user),
      notes: String(v[col('Notes')] || ''),
    };
    const offers = [];
    for (let k = 1; k <= SKYSCANNER.OFFERS; k++) {
      const price = parseAmount_(v[col('#' + k + ' price (₦)')]);
      if (price === null) continue;
      const seller = skySeller_(v[col('#' + k + ' sold by')]);
      if (!seller) throw new Error('Row ' + (i + 1) + ': offer #' + k + ' has a price but no "sold by".');
      const airline = skyAirline_(v[col('#' + k + ' airline')]) || seller.carrier;
      const stops = String(v[col('#' + k + ' stops')]).trim();
      offers.push({ price: price, seller: seller, airline: airline, rank: k,
                    stops: stops === '' ? null : Number(stops) });
    }
    const ours = parseAmount_(v[col('TravelDen on Skyscanner (₦)')]);
    if (ours !== null) {
      offers.push({ price: ours, seller: skySeller_('TravelDen'), airline: null, rank: null, stops: null });
    }
    if (!offers.length) continue;

    offers.forEach(function (o) {
      sellers[o.seller.id] = o.seller;
      const id = Utilities.getUuid().replace(/-/g, '');
      rows.push({ insertId: id, json: {
        snapshot_id: id,
        collection_run_id: runId,
        source_id: SKYSCANNER.SOURCE_ID,
        source_tier: 'PERMITTED_PUBLIC',
        collected_at: now.toISOString(),
        ingested_at: now.toISOString(),
        request_origin: base.origin,
        request_destination: base.destination,
        request_departure_date: base.dep,
        request_return_date: base.ret,
        request_trip_type: base.ret ? 'ROUND_TRIP' : 'ONE_WAY',
        request_cabin: base.cabin,
        request_pax_adults: 1,
        request_pax_children: 0,
        request_pax_infants: 0,
        request_pos_country: TOP_ROUTES.POS_COUNTRY,
        request_currency: TOP_ROUTES.CURRENCY,
        seller_type: o.seller.type,
        seller_id: o.seller.id,
        marketing_carrier: o.airline,
        stops_count: o.stops,
        quote_currency: TOP_ROUTES.CURRENCY,
        displayed_total: String(o.price),
        availability_status: 'AVAILABLE',
        legal_basis: 'PERMITTED_PUBLIC',
        raw_payload: JSON.stringify({
          method: 'manual_skyscanner', seller_name: o.seller.name, skyscanner_rank: o.rank,
          checked_by: base.checkedBy, notes: base.notes,
        }),
      }});
    });
    sentRows.push(i + 1);
  }

  if (!rows.length) {
    ss.toast('Nothing new to send. Type prices in the yellow columns first.', 'TVD OTA FareIQ', 6);
    return;
  }

  registerSellers_(project, sellers);

  const resp = BigQuery.Tabledata.insertAll({ rows: rows, skipInvalidRows: false },
                                            project, 'tvd_fareiq_raw', 'offer_snapshot');
  if (resp.insertErrors && resp.insertErrors.length) {
    throw new Error('BigQuery refused the prices: ' +
                    JSON.stringify(resp.insertErrors[0].errors).slice(0, 300));
  }

  const stamp = Utilities.formatDate(now, tz, 'd MMM yyyy HH:mm') + ' by ' + user;
  sentRows.forEach(function (r) { sheet.getRange(r, sentCol + 1).setValue(stamp); });
  ss.toast(rows.length + ' Skyscanner prices from ' + sentRows.length + ' rows sent to FareIQ. ' +
           'They show in the dashboard within 30 minutes.', 'TVD OTA FareIQ', 8);
}

/** Map a "sold by" name to a seller. Unknown names become new competitor OTAs. */
function skySeller_(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const ota = Object.keys(SKY_OTAS).filter(function (k) { return k.toLowerCase() === lower; })[0];
  if (ota) return { id: SKY_OTAS[ota].id, type: SKY_OTAS[ota].type, name: ota, carrier: null };
  const air = Object.keys(SKY_AIRLINES).filter(function (k) { return k.toLowerCase() === lower; })[0];
  if (air) {
    return { id: 'direct_' + SKY_AIRLINES[air].toLowerCase(), type: 'AIRLINE_DIRECT',
             name: air + ' (direct)', carrier: SKY_AIRLINES[air] };
  }
  return { id: 'ota_' + lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
           type: 'COMPETITOR_OTA', name: raw, carrier: null };
}

/** Airline column accepts a name from the list or a two letter code. */
function skyAirline_(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const name = Object.keys(SKY_AIRLINES).filter(function (k) { return k.toLowerCase() === lower; })[0];
  if (name) return SKY_AIRLINES[name];
  return /^[A-Za-z0-9]{2}$/.test(raw) ? raw.toUpperCase() : null;
}

/** Insert routes missing from dim_route on the 30 minute tier (T1). Routes
 *  already there keep their tier, priority and margin overrides. */
function registerRoutes_(project, routes) {
  const ok = routes.filter(function (r) { return /^[A-Z]{3}$/.test(r.o) && /^[A-Z]{3}$/.test(r.d); });
  if (!ok.length) return;
  const structs = ok.map(function (r, i) {
    return "STRUCT('" + r.o + "-" + r.d + "' AS route_key, '" + r.o + "' AS origin, '" +
           r.d + "' AS destination, " + (100 + i) + " AS pri)";
  }).join(', ');
  const sql =
    'MERGE `' + project + '.tvd_fareiq_mart.dim_route` T ' +
    'USING (SELECT * FROM UNNEST([' + structs + '])) S ON T.route_key = S.route_key ' +
    'WHEN NOT MATCHED THEN INSERT (route_key, origin, destination, ' +
    '  is_monitored, monitoring_tier, strategic_priority, updated_at) ' +
    "VALUES (S.route_key, S.origin, S.destination, TRUE, 'T1', S.pri, CURRENT_TIMESTAMP())";
  try {
    const job = BigQuery.Jobs.query({ query: sql, useLegacySql: false,
                                      location: BOOKING_SYNC.LOCATION }, project);
    waitForJob_(project, job.jobReference.jobId);
  } catch (e) {
    // The check sheet is still useful without this; say so and carry on.
    SpreadsheetApp.getActiveSpreadsheet().toast('Routes not added to FareIQ: ' + e.message,
                                                'TVD OTA FareIQ', 8);
  }
}

/** Add any seller seen for the first time to dim_seller, so the dashboard
 *  shows its name. Existing sellers are left exactly as they are. */
function registerSellers_(project, sellers) {
  const list = Object.keys(sellers).map(function (id) { return sellers[id]; })
    .filter(function (s) { return s.type !== 'US'; });
  if (!list.length) return;
  const esc = function (s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); };
  const structs = list.map(function (s) {
    return "STRUCT('" + esc(s.id) + "' AS seller_id, '" + esc(s.name) + "' AS seller_name, '" +
           s.type + "' AS seller_type)";
  }).join(', ');
  const sql =
    'MERGE `' + project + '.tvd_fareiq_mart.dim_seller` T ' +
    'USING (SELECT * FROM UNNEST([' + structs + '])) S ON T.seller_id = S.seller_id ' +
    'WHEN NOT MATCHED THEN INSERT (seller_id, seller_name, seller_type, is_benchmark, ' +
    '  benchmark_weight, home_market, notes, updated_at) ' +
    "VALUES (S.seller_id, S.seller_name, S.seller_type, TRUE, 1.0, 'NG', " +
    "  'added from the Skyscanner check', CURRENT_TIMESTAMP())";
  const job = BigQuery.Jobs.query({ query: sql, useLegacySql: false,
                                    location: BOOKING_SYNC.LOCATION }, project);
  waitForJob_(project, job.jobReference.jobId);
}
