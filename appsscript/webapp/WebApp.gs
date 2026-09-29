/**
 * TVD OTA FareIQ :: web app entry point and approval surface
 *
 * Deployment: "Execute as: Me (the FareIQ Workspace service identity)",
 * "Who has access: Anyone within <your domain>". Executing as the service
 * identity is what lets the app hold BigQuery read access without granting
 * every analyst a warehouse role; authorisation is then done here, per user,
 * against Workspace groups.
 *
 * The approval endpoints do NOT write to BigQuery. They post to the pricing
 * service with the signed-in user's identity, and the service is the only
 * writer to the audit trail. That separation is the whole control model: the
 * dashboard is an interface, the service is the system of record.
 */

function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'exec';
  const access = resolveAccess_();

  if (!access.role) {
    return HtmlService.createHtmlOutput(
      '<div style="font:15px Garamond,Georgia,serif;padding:48px;color:#17262F">' +
      '<h2 style="margin:0 0 8px">No access</h2>' +
      '<p>' + escapeHtml_(access.email) + ' is not a member of a FareIQ pricing group. ' +
      'Ask the pricing lead to add you, then reload.</p></div>')
      .setTitle('TVD OTA FareIQ');
  }

  const t = HtmlService.createTemplateFromFile('Index');
  t.bootstrap = JSON.stringify({
    user: access.email,
    role: access.role,
    page: allowedPage_(page, access.role),
    pages: PAGES.filter(function (p) { return p.roles.indexOf(access.role) >= 0; }),
    brand: BRAND,
    currency: CFG.CURRENCY,
    today: todayIso_(),
    sheetUrl: CFG.SHEET_ID ? 'https://docs.google.com/spreadsheets/d/' + CFG.SHEET_ID : null,
  });

  return t.evaluate()
    .setTitle('TVD OTA FareIQ')
    .setFaviconUrl('https://ssl.gstatic.com/docs/script/images/favicon.ico')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------------------------------------------------------- authorisation
function resolveAccess_() {
  const email = Session.getActiveUser().getEmail();
  if (!email) return { email: '(unknown)', role: null };

  // Most specific role wins, so a lead who is also an analyst gets lead.
  if (inGroup_(CFG.GROUP_LEADS, email))    return { email: email, role: 'lead' };
  if (inGroup_(CFG.GROUP_ANALYSTS, email)) return { email: email, role: 'analyst' };
  if (inGroup_(CFG.GROUP_EXEC, email))     return { email: email, role: 'exec' };
  return { email: email, role: null };
}

function inGroup_(groupEmail, userEmail) {
  if (!groupEmail) return false;
  const cache = CacheService.getUserCache();
  const key = 'grp:' + groupEmail;
  const hit = cache.get(key);
  if (hit !== null) return hit === '1';
  let member = false;
  try {
    member = GroupsApp.getGroupByEmail(groupEmail).hasUser(userEmail);
  } catch (e) {
    member = false;   // group not visible to this identity: deny, never default open
  }
  cache.put(key, member ? '1' : '0', 600);
  return member;
}

function allowedPage_(page, role) {
  const match = PAGES.filter(function (p) { return p.id === page; })[0];
  if (match && match.roles.indexOf(role) >= 0) return page;
  return PAGES.filter(function (p) { return p.roles.indexOf(role) >= 0; })[0].id;
}

function requireRole_(roles) {
  const access = resolveAccess_();
  if (!access.role || roles.indexOf(access.role) < 0) {
    throw new Error('Not authorised. Your role is ' + (access.role || 'none') + '.');
  }
  return access;
}

// ---------------------------------------------------------------- client API
/**
 * One entry point for the client, so authorisation is checked once, in one
 * place, rather than on every individual function.
 */
function apiFetch(name, args) {
  const access = requireRole_(['analyst', 'lead', 'exec']);
  const a = args || {};

  const execSafe = {
    exec_overview: function () { return getExecOverview(); },
    index_trend:   function () { return getIndexTrend(a.days); },
    competitors:   function () { return getCompetitorRanking(a.days); },
    competitor_series: function () { return getCompetitorWinRateSeries(a.days); },
    movements:     function () { return getCompetitorMovements(); },
    route_list:    function () { return getRouteList(); },
    route:         function () { return getRouteAnalysis(a.routeKey, a.days); },
    elasticity:    function () { return getRouteElasticity(a.routeKey); },
    opportunities: function () { return getOpportunities(); },
    scorecard:     function () { return getEngineScorecard(); },
    freshness:     function () { return getDataFreshness(); },
    audit:         function () { return getDecisionAudit(a.days); },
  };

  const analystOnly = {
    review:      function () { return getDailyReview(a.filters); },
    fee_matrix:  function () { return getFeeMatrix(); },
    fee_changes: function () { return getFeeChanges(a.days); },
    mining:      function () { return getMiningSignals(); },
  };

  if (execSafe[name]) return execSafe[name]();
  if (analystOnly[name]) {
    requireRole_(['analyst', 'lead']);
    return analystOnly[name]();
  }
  throw new Error('Unknown request: ' + name);
}

// ---------------------------------------------------------------- approvals
/**
 * Submit one decision. Validation happens three times on purpose: in the
 * browser for a fast message, here so a crafted client call cannot skip it,
 * and again in the pricing service, which owns the margin floor.
 */
function submitDecision(payload) {
  const access = requireRole_(['analyst', 'lead']);
  const p = payload || {};

  const allowed = ['APPROVED', 'REJECTED', 'MODIFIED', 'DEFERRED'];
  if (allowed.indexOf(p.decision) < 0) throw new Error('Invalid decision: ' + p.decision);
  if (!p.recommendationId) throw new Error('Missing recommendation');
  if ((p.decision === 'MODIFIED' || p.decision === 'REJECTED') && !p.overrideReason) {
    throw new Error('A reason is required to ' + p.decision.toLowerCase().replace('d', '') + '.');
  }
  if (p.decision === 'MODIFIED') {
    const price = Number(p.approvedPrice);
    if (!isFinite(price) || price <= 0) throw new Error('Enter a valid approved price.');
  }

  const body = {
    recommendation_id: p.recommendationId,
    decision: p.decision,
    approved_price: p.decision === 'MODIFIED' ? Number(p.approvedPrice) : null,
    override_reason: p.overrideReason || null,
    decided_by: access.email,
    decision_channel: 'DASHBOARD',
  };

  const resp = UrlFetchApp.fetch(CFG.PRICING_URL + '/decision', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getIdentityToken() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code === 200) {
    invalidateCache('review');
    invalidateCache('opportunities');
    return { ok: true, result: JSON.parse(resp.getContentText()) };
  }

  // 422 is the margin floor refusing an approved price. Surface the service's
  // own sentence rather than a generic failure: it names the rule to change.
  let message = resp.getContentText();
  try { message = JSON.parse(message).detail || message; } catch (e) {}
  return { ok: false, status: code, message: String(message).slice(0, 400) };
}

/** Approve several rows in one action, reporting per-row outcomes. */
function submitDecisionBatch(items) {
  requireRole_(['analyst', 'lead']);
  if (!items || !items.length) return { ok: true, submitted: 0, failures: [] };
  if (items.length > 50) throw new Error('Submit at most 50 rows at a time.');

  let submitted = 0;
  const failures = [];
  items.forEach(function (item) {
    try {
      const r = submitDecision(item);
      if (r.ok) submitted++;
      else failures.push({ id: item.recommendationId, message: r.message });
    } catch (err) {
      failures.push({ id: item.recommendationId, message: err.message });
    }
  });
  return { ok: failures.length === 0, submitted: submitted, failures: failures };
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
