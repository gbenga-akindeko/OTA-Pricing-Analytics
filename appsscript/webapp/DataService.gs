/**
 * TVD OTA FareIQ :: data service
 *
 * The only place in the web app that talks to BigQuery. Three rules it
 * enforces so a dashboard can never become an expensive surprise:
 *
 *   1. Every query reads a mart VIEW, never fact_offer. The views are
 *      pre-aggregated; fact_offer is one to two orders of magnitude larger.
 *   2. Every query carries maximumBytesBilled. A mistake fails, it does not bill.
 *   3. Every result is cached. Collection is hourly, so a 15 minute cache
 *      costs nothing in freshness and takes most page loads to zero queries.
 *
 * All query parameters are bound, never interpolated. The only strings
 * concatenated into SQL are the project id and identifiers validated against
 * an allowlist.
 */

// ---------------------------------------------------------------- public API
// Each returns { columns: [...], rows: [[...]], cached: bool, ms: n }

function getExecOverview() {
  return cachedQuery_('exec_overview', CFG.CACHE_SECONDS, function () {
    return q_(
      'SELECT * FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_exec_overview`', []);
  });
}

function getIndexTrend(days) {
  const d = clampInt_(days, 7, 180, 90);
  return cachedQuery_('index_trend_' + d, CFG.CACHE_SECONDS, function () {
    return q_(
      'SELECT snapshot_date, region_pair, ' +
      '       ROUND(AVG(price_index_vs_median), 4) AS price_index, ' +
      '       ROUND(AVG(coverage_score), 3) AS coverage ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.fact_market_snapshot` ms ' +
      'JOIN `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.dim_route` r USING (route_key) ' +
      'WHERE ms.snapshot_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @d DAY) ' +
      'GROUP BY snapshot_date, region_pair ORDER BY snapshot_date',
      [intParam_('d', d)]);
  });
}

function getDailyReview(filters) {
  const f = filters || {};
  const key = 'review_' + JSON.stringify(f);
  return cachedQuery_(key, CFG.CACHE_SECONDS_REVIEW, function () {
    const where = ['review_date = @review_date'];
    const params = [dateParam_('review_date', f.reviewDate || todayIso_())];

    if (f.priority)       { where.push('priority = @priority');             params.push(strParam_('priority', f.priority)); }
    if (f.classification) { where.push('classification = @classification'); params.push(strParam_('classification', f.classification)); }
    if (f.action)         { where.push('action = @action');                 params.push(strParam_('action', f.action)); }
    if (f.carrier)        { where.push('marketing_carrier = @carrier');     params.push(strParam_('carrier', f.carrier)); }
    if (f.region)         { where.push('region_pair = @region');            params.push(strParam_('region', f.region)); }
    if (f.status)         { where.push('status = @status');                 params.push(strParam_('status', f.status)); }
    if (f.minConfidence)  { where.push('confidence >= @minconf');           params.push(floatParam_('minconf', f.minConfidence)); }
    if (f.actionableOnly) { where.push('action != "HOLD"'); }

    return q_(
      'SELECT recommendation_id, route_key, origin_city, destination_city, ' +
      '       marketing_carrier, departure_date, cabin, days_to_departure, ' +
      '       our_price, our_true_customer_cost, cheapest_competitor, ' +
      '       cheapest_competitor_price, market_median, price_gap, price_gap_pct, ' +
      '       price_index, our_market_rank, panel_size, current_margin_pct, ' +
      '       minimum_price, recommended_price, price_change_pct, classification, ' +
      '       action, priority, confidence, expected_revenue_impact, ' +
      '       expected_margin_impact, reason_codes, rationale, status ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_daily_pricing_review` ' +
      'WHERE ' + where.join(' AND ') + ' ' +
      'ORDER BY CASE priority WHEN "P1" THEN 1 WHEN "P2" THEN 2 ELSE 3 END, ' +
      '         ABS(expected_margin_impact) DESC ' +
      'LIMIT @lim',
      params.concat([intParam_('lim', CFG.MAX_ROWS)]));
  });
}

function getCompetitorRanking(days) {
  const d = clampInt_(days, 1, 90, 30);
  return cachedQuery_('competitors_' + d, CFG.CACHE_SECONDS, function () {
    return q_(
      'SELECT seller_id, ANY_VALUE(seller_name) AS seller_name, ' +
      '       SUM(cells_observed) AS cells, SUM(times_cheapest) AS wins, ' +
      '       ROUND(SAFE_DIVIDE(SUM(times_cheapest), SUM(cells_observed)), 4) AS win_rate, ' +
      '       ROUND(AVG(avg_rank), 2) AS avg_rank, ' +
      '       ROUND(AVG(median_price), 0) AS median_price ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_competitor_intelligence` ' +
      'WHERE obs_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @d DAY) ' +
      'GROUP BY seller_id ORDER BY win_rate DESC',
      [intParam_('d', d)]);
  });
}

function getCompetitorWinRateSeries(days) {
  const d = clampInt_(days, 7, 90, 45);
  return cachedQuery_('competitor_series_' + d, CFG.CACHE_SECONDS, function () {
    return q_(
      'SELECT obs_date, seller_id, ROUND(cheapest_win_rate, 4) AS win_rate ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_competitor_intelligence` ' +
      'WHERE obs_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @d DAY) ' +
      '  AND cells_observed >= 5 ORDER BY obs_date',
      [intParam_('d', d)]);
  });
}

function getCompetitorMovements() {
  return cachedQuery_('movements', CFG.CACHE_SECONDS, function () {
    return q_(
      'SELECT obs_date, seller_id, route_key, cabin, prev_median_price, ' +
      '       median_price, change_pct, movement_band ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_competitor_movements` ' +
      'WHERE obs_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) ' +
      '  AND movement_band IN ("MAJOR", "NOTABLE") ' +
      'ORDER BY obs_date DESC, ABS(change_pct) DESC LIMIT 100', []);
  });
}

function getFeeMatrix() {
  return cachedQuery_('fee_matrix', 3600, function () {
    return q_(
      'SELECT carrier, carrier_name, fee_type, pos_country, cabin, ' +
      '       amount, currency, basis, effective_since, days_in_effect ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_airline_fee_current` ' +
      'ORDER BY carrier, fee_type', []);
  });
}

function getFeeChanges(days) {
  const d = clampInt_(days, 1, 180, 30);
  return cachedQuery_('fee_changes_' + d, 3600, function () {
    return q_(
      'SELECT change_date, carrier, fee_type, pos_country, previous_amount, ' +
      '       new_amount, change_delta, change_pct, currency, impact_band ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_airline_fee_changes` ' +
      'WHERE change_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @d DAY) ' +
      'ORDER BY change_date DESC, ABS(change_pct) DESC LIMIT 200',
      [intParam_('d', d)]);
  });
}

function getRouteList() {
  return cachedQuery_('route_list', 3600, function () {
    return q_(
      'SELECT route_key, origin_city, destination_city, region_pair, monitoring_tier ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.dim_route` ' +
      'WHERE is_monitored ORDER BY strategic_priority, route_key', []);
  });
}

function getRouteAnalysis(routeKey, days) {
  if (!/^[A-Z]{3}-[A-Z]{3}$/.test(String(routeKey || ''))) {
    throw new Error('Route must look like LOS-LHR');
  }
  const d = clampInt_(days, 30, 365, 180);
  return cachedQuery_('route_' + routeKey + '_' + d, CFG.CACHE_SECONDS, function () {
    return q_(
      'SELECT snapshot_date, cabin, our_price, market_median, cheapest_competitor, ' +
      '       price_index, coverage, bookings, pax, revenue, margin, margin_pct, ' +
      '       avg_booking_lead_days, searches, purchases, conversion_pct ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_route_analysis` ' +
      'WHERE route_key = @rk ' +
      '  AND snapshot_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @d DAY) ' +
      'ORDER BY snapshot_date',
      [strParam_('rk', routeKey), intParam_('d', d)]);
  });
}

function getRouteElasticity(routeKey) {
  if (!/^[A-Z]{3}-[A-Z]{3}$/.test(String(routeKey || ''))) return { columns: [], rows: [] };
  return cachedQuery_('elasticity_' + routeKey, 3600, function () {
    return q_(
      'SELECT cabin, ROUND(elasticity, 2) AS elasticity, elasticity_source, ' +
      '       weeks, total_pax ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_ml.route_elasticity` ' +
      'WHERE route_key = @rk',
      [strParam_('rk', routeKey)]);
  });
}

function getOpportunities() {
  return cachedQuery_('opportunities', CFG.CACHE_SECONDS_REVIEW, function () {
    return q_(
      'SELECT recommendation_id, route_key, departure_date, cabin, marketing_carrier, ' +
      '       classification, action, priority, current_price, recommended_price, ' +
      '       minimum_price, change_pct, current_margin_pct, potential_revenue, ' +
      '       potential_margin, opportunity_value, confidence, status ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_pricing_opportunities` ' +
      'WHERE review_date = CURRENT_DATE() ' +
      'ORDER BY opportunity_value DESC LIMIT @lim',
      [intParam_('lim', CFG.MAX_ROWS)]);
  });
}

function getDecisionAudit(days) {
  const d = clampInt_(days, 1, 180, 30);
  return cachedQuery_('audit_' + d, CFG.CACHE_SECONDS, function () {
    return q_(
      'SELECT decided_at, decided_by, decision, decision_channel, route_key, ' +
      '       departure_date, cabin, price_before, price_recommended, price_approved, ' +
      '       override_reason, benchmark_cheapest, benchmark_median, benchmark_panel, ' +
      '       expected_margin_pct, confidence, apply_status, actual_bookings_7d, ' +
      '       actual_margin_7d, actual_vs_expected_pct ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_decision_audit` ' +
      'WHERE decided_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @h HOUR) ' +
      'ORDER BY decided_at DESC LIMIT @lim',
      [intParam_('h', d * 24), intParam_('lim', CFG.MAX_ROWS)]);
  });
}

function getEngineScorecard() {
  return cachedQuery_('scorecard', 3600, function () {
    return q_(
      'SELECT week, decisions, approved, modified, rejected, acceptance_rate, ' +
      '       avg_override_magnitude, avg_forecast_error, realised_margin_7d ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.v_engine_scorecard` ' +
      'ORDER BY week', []);
  });
}

/** Anomalies and clusters produced by the Python mining jobs. */
function getMiningSignals() {
  return cachedQuery_('mining', CFG.CACHE_SECONDS, function () {
    return q_(
      'SELECT signal_date, signal_type, severity, route_key, seller_id, carrier, ' +
      '       metric, observed_value, expected_value, deviation_score, detail ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.fact_mining_signal` ' +
      'WHERE signal_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) ' +
      'ORDER BY severity DESC, ABS(deviation_score) DESC LIMIT 200', []);
  });
}

/** Freshness banner. A dashboard that hides stale data is worse than none. */
function getDataFreshness() {
  return cachedQuery_('freshness', 300, function () {
    return q_(
      'SELECT MAX(collection_window) AS last_collection, ' +
      '       TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(collection_window), MINUTE) AS minutes_ago, ' +
      '       COUNT(DISTINCT route_key) AS routes_in_last_window, ' +
      '       ROUND(AVG(coverage_score), 3) AS avg_coverage ' +
      'FROM `' + CFG.PROJECT_ID + '.tvd_fareiq_mart.fact_market_snapshot` ' +
      'WHERE snapshot_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)', []);
  });
}

// ---------------------------------------------------------------- engine room

function q_(sql, params) {
  const started = Date.now();
  const request = {
    query: sql,
    useLegacySql: false,
    location: CFG.BQ_LOCATION,
    maximumBytesBilled: CFG.MAX_BYTES_BILLED,
    timeoutMs: CFG.QUERY_TIMEOUT_MS,
    parameterMode: params && params.length ? 'NAMED' : undefined,
    queryParameters: params && params.length ? params : undefined,
  };

  let job = BigQuery.Jobs.query(request, CFG.PROJECT_ID);
  let waited = 0;
  while (!job.jobComplete && waited < CFG.QUERY_TIMEOUT_MS) {
    Utilities.sleep(1200);
    waited += 1200;
    job = BigQuery.Jobs.getQueryResults(CFG.PROJECT_ID, job.jobReference.jobId,
                                        { location: CFG.BQ_LOCATION });
  }
  if (!job.jobComplete) throw new Error('BigQuery query timed out after ' + waited + 'ms');

  const fields = (job.schema && job.schema.fields) || [];
  return {
    columns: fields.map(function (f) { return { name: f.name, type: f.type }; }),
    rows: (job.rows || []).map(function (r) {
      return r.f.map(function (c, i) { return coerce_(c.v, fields[i] && fields[i].type); });
    }),
    bytes: Number(job.totalBytesProcessed || 0),
    ms: Date.now() - started,
    cached: false,
  };
}

/**
 * CacheService caps a single entry at 100 KB, which a 500 row table exceeds,
 * so large payloads are split across numbered chunks under one index key.
 */
function cachedQuery_(key, seconds, producer) {
  const cache = CacheService.getScriptCache();
  const k = 'fq:' + key;
  try {
    const index = cache.get(k);
    if (index) {
      const meta = JSON.parse(index);
      const parts = cache.getAll(meta.keys);
      if (Object.keys(parts).length === meta.keys.length) {
        const joined = meta.keys.map(function (pk) { return parts[pk]; }).join('');
        const out = JSON.parse(joined);
        out.cached = true;
        return out;
      }
    }
  } catch (e) {
    // A cache miss or a corrupt entry is never fatal: fall through and query.
  }

  const result = producer();
  try {
    const payload = JSON.stringify(result);
    const CHUNK = 90000;
    const keys = [];
    const parts = {};
    for (let i = 0, n = 0; i < payload.length; i += CHUNK, n++) {
      const pk = k + ':' + n;
      keys.push(pk);
      parts[pk] = payload.substring(i, i + CHUNK);
    }
    cache.putAll(parts, seconds);
    cache.put(k, JSON.stringify({ keys: keys }), seconds);
  } catch (e) {
    // Oversized or unavailable cache: serve the live result anyway.
  }
  return result;
}

function invalidateCache(prefix) {
  // Apps Script cannot enumerate cache keys, so invalidation is by known key.
  const cache = CacheService.getScriptCache();
  const known = ['exec_overview', 'review_{}', 'opportunities', 'freshness',
                 'audit_30', 'scorecard', 'mining'];
  known.forEach(function (key) {
    if (!prefix || key.indexOf(prefix) === 0) {
      const k = 'fq:' + key;
      const index = cache.get(k);
      if (index) {
        try { cache.removeAll(JSON.parse(index).keys.concat([k])); } catch (e) {}
      }
    }
  });
}

function coerce_(v, type) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'INTEGER': case 'INT64':
      return parseInt(v, 10);
    case 'FLOAT': case 'FLOAT64': case 'NUMERIC': case 'BIGNUMERIC':
      return parseFloat(v);
    case 'BOOLEAN': case 'BOOL':
      return v === 'true' || v === true;
    default:
      return v;
  }
}

// ---------------------------------------------------------------- parameters
function strParam_(name, value) {
  return { name: name, parameterType: { type: 'STRING' },
           parameterValue: { value: String(value) } };
}
function intParam_(name, value) {
  return { name: name, parameterType: { type: 'INT64' },
           parameterValue: { value: String(parseInt(value, 10)) } };
}
function floatParam_(name, value) {
  return { name: name, parameterType: { type: 'FLOAT64' },
           parameterValue: { value: String(parseFloat(value)) } };
}
function dateParam_(name, value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error('Bad date: ' + value);
  return { name: name, parameterType: { type: 'DATE' },
           parameterValue: { value: String(value) } };
}

function clampInt_(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.min(Math.max(n, lo), hi);
}

function todayIso_() {
  return Utilities.formatDate(new Date(), CFG.TIMEZONE, 'yyyy-MM-dd');
}
