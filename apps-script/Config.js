/**
 * Static configuration for the Finance Portal.
 *
 * Everything that finance staff may want to change day to day (company name,
 * validity note, copy lists, etc.) lives in the "Settings" tab of the database
 * sheet instead of here.
 */

var APP_VERSION = '1.0.0';

/** Roles, lowest to highest. A user can do everything a lower role can do. */
var ROLES = {
  VIEWER: { rank: 1, label: 'Viewer' },
  RATE_SETTER: { rank: 2, label: 'Rate Setter (Financial Controller)' },
  ADMIN: { rank: 3, label: 'Administrator (CFO)' }
};

/** Tabs in the database spreadsheet. Headers are matched by name, so columns can be reordered. */
var SHEETS = {
  SETTINGS: { name: 'Settings', headers: ['Key', 'Value', 'Description'] },
  USERS: {
    name: 'Users',
    headers: ['Email', 'Full Name', 'Role', 'Subsidiary', 'Active', 'Created At', 'Created By', 'Last Login']
  },
  SUBSIDIARIES: {
    name: 'Subsidiaries',
    headers: ['Code', 'Subsidiary Name', 'Head of Finance', 'Head of Finance Email', 'CC Emails', 'Active', 'Updated At', 'Updated By']
  },
  CATEGORIES: {
    name: 'Rate Categories',
    headers: ['Currency', 'Display Name', 'Category', 'Sort Order', 'Active']
  },
  PUBLICATIONS: {
    name: 'ROE Publications',
    headers: ['Publication ID', 'Effective At', 'Published At', 'Published By', 'Note', 'Status', 'Email Status', 'Voided At', 'Voided By', 'Void Reason']
  },
  ROE: {
    name: 'ROE Log',
    headers: ['Publication ID', 'Effective At', 'Currency', 'Category', 'Rate', 'Published By', 'Status']
  },
  BOOK: { name: 'Rate Log', headers: ['Effective Date', 'USD', 'EUR', 'GBP'] },
  EMAIL_LOG: {
    name: 'Email Log',
    headers: ['Timestamp', 'Publication ID', 'Type', 'Subsidiary', 'To', 'CC', 'Status', 'Detail']
  },
  AUDIT: { name: 'Audit Log', headers: ['Timestamp', 'User', 'Category', 'Action', 'Details'] }
};

/** Default values written to the Settings tab on first setup. */
var DEFAULT_SETTINGS = [
  ['COMPANY_NAME', 'Finchglow Holdings', 'Shown in the portal header and in emails.'],
  ['LOGO_URL', '', 'Public https link to the Finchglow Holdings logo (PNG or SVG). Used in the portal and in emails.'],
  ['PORTAL_NAME', 'Finance One-Stop Portal', 'Name of the portal.'],
  ['VALIDITY_NOTE', 'This rate is ONLY VALID for a limited time. Pls call to ask in 15-mins if your client is yet to pay', 'Default note added to every ROE broadcast.'],
  ['EMAIL_SUBJECT_PREFIX', '[ROE]', 'Text placed at the start of every ROE email subject.'],
  ['EMAIL_SENDER_NAME', 'Finchglow Holdings Finance', 'Display name on outgoing emails.'],
  ['REPLY_TO', '', 'Optional reply-to address for ROE emails (e.g. the treasury desk).'],
  ['INTERNAL_COPY_EMAILS', '', 'Comma separated addresses that get one copy of every ROE email (e.g. CFO, treasury).'],
  ['LARGE_CHANGE_PERCENT', '10', 'Ask for confirmation when a rate moves by more than this percent. Guards against typos.'],
  ['PORTAL_URL', '', 'Link used in emails. Leave blank to use the web app URL automatically.']
];

/**
 * Default ROE categories, taken from the current WhatsApp broadcasts.
 * Currencies are listed in the order used in the broadcast (USD, POUNDS, EURO).
 */
var DEFAULT_CATEGORIES = [
  ['USD', 'USD', 'Agent / Direct', 10, true],
  ['USD', 'USD', 'Corporate - Link', 20, true],
  ['USD', 'USD', 'Corporate - Invoice', 30, true],
  ['GBP', 'POUNDS', 'Immediate payment', 40, true],
  ['GBP', 'POUNDS', 'Corporate - Invoice', 50, true],
  ['EUR', 'EURO', 'Immediate payment', 60, true],
  ['EUR', 'EURO', 'Corporate - Invoice', 70, true]
];

/** Book rate history from "Exchange Rate Log - 2026.xlsx", used to seed a brand new Rate Log tab. */
var SEED_BOOK_RATES = [
  ['2025-12-10', 1446.74, 1677.65, 1915.7],
  ['2025-12-31', 1449.66, 1677.65, 1956.07],
  ['2026-07-06', 1410, 1677.65, 1956.07],
  ['2026-10-06', 1348, 1517.02, 1785.45]
];

var AUTH = {
  CODE_TTL_SECONDS: 10 * 60,
  CODE_MAX_ATTEMPTS: 5,
  CODE_RESEND_SECONDS: 60,
  SESSION_IDLE_SECONDS: 4 * 60 * 60,
  SESSION_MAX_SECONDS: 12 * 60 * 60
};

var MAX_RATE = 1000000;
