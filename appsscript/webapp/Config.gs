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
  // The identity the app calls the pricing service as. It must hold
  // run.invoker on the pricing service.
  get PRICING_INVOKER_SA() {
    return prop_('PRICING_INVOKER_SA',
                 'tvd-ota-fareiq-workspace@' + prop_('GCP_PROJECT') + '.iam.gserviceaccount.com');
  },
  get SHEET_ID()     { return prop_('CONFIG_SHEET_ID'); },
  get TIMEZONE()     { return 'Africa/Lagos'; },
  get CURRENCY()     { return '₦'; },

  // Who may see what. Either name people directly (comma separated emails)
  // or point at Workspace groups, or both. Both are read at request time, so
  // a change takes effect on the next page load. Named emails suit people
  // outside the domain, whom a domain group may not be allowed to hold.
  get USERS_LEADS()    { return prop_('USERS_LEADS', ''); },
  get USERS_ANALYSTS() { return prop_('USERS_ANALYSTS', ''); },
  get USERS_EXEC()     { return prop_('USERS_EXEC', ''); },
  get GROUP_ANALYSTS() { return prop_('GROUP_ANALYSTS', ''); },
  get GROUP_LEADS()    { return prop_('GROUP_LEADS', ''); },
  get GROUP_EXEC()     { return prop_('GROUP_EXEC', ''); },

  // Cost guards. A runaway query should fail, not bill.
  MAX_BYTES_BILLED: '2000000000',     // 2 GB per query
  QUERY_TIMEOUT_MS: 45000,
  CACHE_SECONDS: 600,                 // 10 min; collection cadence is every 30 min
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
    USERS_LEADS: 'lead@yourdomain.com',
    USERS_ANALYSTS: '',
    USERS_EXEC: 'viewer1@yourdomain.com,viewer2@partner.com',
    GROUP_ANALYSTS: '',
    GROUP_LEADS: '',
    GROUP_EXEC: '',
  }, false);
}
