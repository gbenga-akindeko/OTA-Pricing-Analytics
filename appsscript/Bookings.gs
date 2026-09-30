/**
 * TVD OTA FareIQ :: real bookings from the live sales register
 *
 * syncBookingsToFareIQ() reads the Transactions tab of the live TVD sales
 * register and loads every issued ticket into tvd_fareiq_mart.fact_booking.
 * It runs every morning at 05:00 (see installTriggers) so the 05:30 transform
 * prices each market cell on TravelDen's real margins, and it can be run by
 * hand from the FareIQ menu at any time.
 *
 * What is loaded, per ticket: transaction id, PNR, issue date, route, cabin,
 * airline, issuing channel ("Issued from"), client type, and the naira net
 * fare, amount paid and income. Passenger names, client names and ticket
 * numbers are never read into FareIQ.
 *
 * The run is idempotent. Each sync replaces a staging table and MERGEs it
 * into fact_booking by transaction id: edited transactions are updated, new
 * ones inserted, and tickets that have left the register (voided) removed.
 */

const BOOKING_SYNC = {
  STAGING_DATASET: 'tvd_fareiq_raw',
  STAGING_TABLE: 'tvd_transactions_sync',
  KEY_PREFIX: 'TRX',               // only rows the sync owns are ever deleted
  LOCATION: 'europe-west2',
};

function syncBookingsToFareIQ() {
  const project = CONFIG.PROJECT_ID || 'tvd-fareiq-prod';
  const src = SpreadsheetApp.openById(TOP_ROUTES.SALES_SHEET_ID);
  const tab = src.getSheets().filter(function (s) {
    return s.getSheetId() === TOP_ROUTES.SALES_TAB_GID;
  })[0] || src.getSheetByName(TOP_ROUTES.SALES_TAB_NAME);
  if (!tab) throw new Error('Could not find the Transactions tab in the sales register.');

  const values = tab.getDataRange().getValues();
  const headers = values[0].map(function (h) { return String(h).trim().toUpperCase(); });
  const col = function (name) {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error('Sales register has no "' + name + '" column.');
    return i;
  };
  const c = {
    id: col('TRANSACTION ID'), date: col('DATE'), product: col('PRODUCT TYPE'),
    issuedFrom: col('ISSUED FROM'), clientType: col('CLIENT TYPE'), pnr: col('PNR'),
    airline: col('AIRLINE CODE'), itinerary: col('ITINERARY'), status: col('TRANSACTION STATUS'),
    cabin: col('CABIN CLASS'), paid: col('NGN AMOUNT PAID'), net: col('NGN NET FARE'),
    income: col('NGN INCOME'),
  };

  const tz = 'Africa/Lagos';
  const seen = {};
  const lines = [];
  let skipped = 0;
  for (let r = 1; r < values.length; r++) {
    const v = values[r];
    const id = String(v[c.id] || '').trim();
    if (!id || seen[id]) continue;
    if (String(v[c.status]).trim().toUpperCase() !== 'ISSUED') continue;
    if (String(v[c.product]).trim().toUpperCase() !== 'TICKET') continue;

    const od = parseItinerary_(v[c.itinerary]);
    const paid = parseAmount_(v[c.paid]);
    const net = parseAmount_(v[c.net]);
    const date = v[c.date];
    if (!od || paid === null || net === null || !(date instanceof Date)) { skipped++; continue; }
    seen[id] = true;

    const income = Number(String(v[c.income]).replace(/[^0-9.\-]/g, ''));
    lines.push(JSON.stringify({
      booking_sk: id,
      booking_reference: String(v[c.pnr] || id).trim(),
      booking_date: Utilities.formatDate(date, tz, 'yyyy-MM-dd'),
      route_key: od.route_key,
      trip_type: od.trip_type,
      itinerary: od.itinerary,
      cabin: String(v[c.cabin] || 'ECONOMY').trim().toUpperCase().replace(/\s+/g, '_'),
      marketing_carrier: String(v[c.airline] || '').trim().toUpperCase() || null,
      channel: String(v[c.issuedFrom] || '').trim().toUpperCase() || null,
      customer_segment: String(v[c.clientType] || '').trim().toUpperCase() || null,
      supplier_cost_base: net.toFixed(2),
      selling_price_base: paid.toFixed(2),
      gross_margin_base: (isFinite(income) ? income : paid - net).toFixed(2),
    }));
  }
  if (!lines.length) throw new Error('No issued tickets found to sync.');

  // 1. Replace the staging table with this snapshot of the register.
  const load = BigQuery.Jobs.insert({
    configuration: { load: {
      destinationTable: { projectId: project, datasetId: BOOKING_SYNC.STAGING_DATASET,
                          tableId: BOOKING_SYNC.STAGING_TABLE },
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      writeDisposition: 'WRITE_TRUNCATE',
      createDisposition: 'CREATE_IF_NEEDED',
      schema: { fields: [
        { name: 'booking_sk', type: 'STRING' }, { name: 'booking_reference', type: 'STRING' },
        { name: 'booking_date', type: 'DATE' }, { name: 'route_key', type: 'STRING' },
        { name: 'trip_type', type: 'STRING' }, { name: 'itinerary', type: 'STRING' },
        { name: 'cabin', type: 'STRING' },
        { name: 'marketing_carrier', type: 'STRING' }, { name: 'channel', type: 'STRING' },
        { name: 'customer_segment', type: 'STRING' },
        { name: 'supplier_cost_base', type: 'NUMERIC' },
        { name: 'selling_price_base', type: 'NUMERIC' },
        { name: 'gross_margin_base', type: 'NUMERIC' },
      ]},
    }},
    jobReference: { projectId: project, location: BOOKING_SYNC.LOCATION },
  }, project, Utilities.newBlob(lines.join('\n'), 'application/octet-stream'));
  waitForJob_(project, load.jobReference.jobId);

  // 2. Merge into fact_booking. Only rows the sync owns (TRX ids) are touched,
  // so synthetic MOCK bookings and any other source are left alone.
  const staging = '`' + project + '.' + BOOKING_SYNC.STAGING_DATASET + '.' + BOOKING_SYNC.STAGING_TABLE + '`';
  const target = '`' + project + '.tvd_fareiq_mart.fact_booking`';
  const merge =
    'MERGE ' + target + ' T ' +
    'USING (SELECT * FROM ' + staging + ' ' +
    '       QUALIFY ROW_NUMBER() OVER (PARTITION BY booking_sk ORDER BY booking_date DESC) = 1) S ' +
    'ON T.booking_sk = S.booking_sk ' +
    'WHEN MATCHED THEN UPDATE SET ' +
    '  booking_reference = S.booking_reference, booked_at = TIMESTAMP(S.booking_date), ' +
    '  booking_date = S.booking_date, route_key = S.route_key, cabin = S.cabin, ' +
    '  trip_type = S.trip_type, itinerary = S.itinerary, ' +
    '  marketing_carrier = S.marketing_carrier, channel = S.channel, ' +
    '  customer_segment = S.customer_segment, supplier_cost_base = S.supplier_cost_base, ' +
    '  selling_price_base = S.selling_price_base, gross_margin_base = S.gross_margin_base, ' +
    '  gross_margin_pct = SAFE_DIVIDE(S.gross_margin_base, S.selling_price_base) ' +
    'WHEN NOT MATCHED THEN INSERT (booking_sk, booking_reference, booked_at, booking_date, ' +
    '  route_key, trip_type, itinerary, departure_date, booking_lead_days, cabin, marketing_carrier, channel, ' +
    '  customer_segment, pos_country, pax_count, supplier_cost_base, selling_price_base, ' +
    '  gross_margin_base, gross_margin_pct, status) ' +
    'VALUES (S.booking_sk, S.booking_reference, TIMESTAMP(S.booking_date), S.booking_date, ' +
    '  S.route_key, S.trip_type, S.itinerary, NULL, NULL, S.cabin, S.marketing_carrier, S.channel, S.customer_segment, ' +
    "  'NG', 1, S.supplier_cost_base, S.selling_price_base, S.gross_margin_base, " +
    "  IFNULL(SAFE_DIVIDE(S.gross_margin_base, S.selling_price_base), 0), 'TICKETED') " +
    "WHEN NOT MATCHED BY SOURCE AND STARTS_WITH(T.booking_sk, '" + BOOKING_SYNC.KEY_PREFIX + "') " +
    '  THEN DELETE';
  const job = BigQuery.Jobs.query({ query: merge, useLegacySql: false,
                                    location: BOOKING_SYNC.LOCATION }, project);
  waitForJob_(project, job.jobReference.jobId);

  const msg = lines.length + ' issued tickets synced to FareIQ' +
              (skipped ? ' (' + skipped + ' skipped: no route, price or date)' : '') + '.';
  try {
    logSync_(SpreadsheetApp.getActiveSpreadsheet(),
             [{ table: 'fact_booking', rows: lines.length, errors: skipped ? [skipped + ' skipped'] : [] }]);
  } catch (e) { console.log('sync log not written: ' + e.message); }
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'TVD OTA FareIQ', 8); } catch (e) {}
  return msg;
}

/** Wait for a BigQuery job and raise its error, if any. */
function waitForJob_(project, jobId) {
  for (let i = 0; i < 60; i++) {
    const j = BigQuery.Jobs.get(project, jobId, { location: BOOKING_SYNC.LOCATION });
    if (j.status && j.status.state === 'DONE') {
      if (j.status.errorResult) {
        throw new Error('BigQuery job failed: ' + j.status.errorResult.message);
      }
      return j;
    }
    Utilities.sleep(2000);
  }
  throw new Error('BigQuery job ' + jobId + ' did not finish in time.');
}
