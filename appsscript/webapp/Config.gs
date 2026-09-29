/**
 * TVD OTA FareIQ :: dashboard web app configuration
 *
 * Every value here comes from Script Properties, never from source. Set them
 * once with setupScriptProperties() from the Apps Script editor, or through
 * the project settings UI.
 */

const CFG = {
  get PROJECT_ID()   { return prop_('GCP_PROJECT'); },
  get BQ_LOCATION()  { return prop_('BQ_LOCATION', 'europe-west2'); },
  get PRICING_URL()  { return prop_('PRICING_SERVICE_URL'); },
  get SHEET_ID()     { return prop_('CONFIG_SHEET_ID'); },
  get TIMEZONE()     { return 'Africa/Lagos'; },
  get CURRENCY()     { return '₦'; },

  // Who may see what. Groups are resolved at request time, so an access
  // change in Workspace takes effect on the next page load.
  get GROUP_ANALYSTS() { return prop_('GROUP_ANALYSTS'); },
  get GROUP_LEADS()    { return prop_('GROUP_LEADS'); },
  get GROUP_EXEC()     { return prop_('GROUP_EXEC'); },

  // Cost guards. A runaway query should fail, not bill.
  MAX_BYTES_BILLED: '2000000000',     // 2 GB per query
  QUERY_TIMEOUT_MS: 45000,
  CACHE_SECONDS: 900,                 // 15 min; collection cadence is hourly
  CACHE_SECONDS_REVIEW: 120,          // the working page refreshes faster
  MAX_ROWS: 500,
};

/** TravelDen palette, sampled from the lockup. Shared with the client. */
const BRAND = {
  navy:   '#002A48',
  green:  '#00A651',
  dgreen: '#00502A',
  orange: '#F58220',
  sky:    '#8ED8F8',
  rust:   '#A42B20',
  ink:    '#17262F',
  mute:   '#5E7079',
  rule:   '#DCE5E1',
  tint:   '#F2F7F4',
  tint2:  '#EEF3F7',
  white:  '#FFFFFF',
};

const PAGES = [
  { id: 'exec',       label: 'Overview',    roles: ['analyst', 'lead', 'exec'] },
  { id: 'review',     label: 'Daily review', roles: ['analyst', 'lead'] },
  { id: 'competitor', label: 'Competitors', roles: ['analyst', 'lead', 'exec'] },
  { id: 'fees',       label: 'Airline fees', roles: ['analyst', 'lead'] },
  { id: 'route',      label: 'Routes',      roles: ['analyst', 'lead', 'exec'] },
  { id: 'audit',      label: 'Opportunities & audit', roles: ['analyst', 'lead', 'exec'] },
];

function prop_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error('Missing script property: ' + key +
    '. Run setupScriptProperties() or set it in project settings.');
}

/** Run once from the editor after pasting in the real values. */
function setupScriptProperties() {
  PropertiesService.getScriptProperties().setProperties({
    GCP_PROJECT: 'your-gcp-project',
    BQ_LOCATION: 'europe-west2',
    PRICING_SERVICE_URL: 'https://tvd-ota-fareiq-pricing-xxxxx.a.run.app',
    CONFIG_SHEET_ID: 'your-pricing-config-sheet-id',
    GROUP_ANALYSTS: 'pricing-analysts@yourdomain.com',
    GROUP_LEADS: 'pricing-leads@yourdomain.com',
    GROUP_EXEC: 'commercial-exec@yourdomain.com',
  }, false);
}
