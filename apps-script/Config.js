/**
 * Static configuration for the Finance Portal.
 *
 * Everything that finance staff may want to change day to day (company name,
 * validity note, copy lists, etc.) lives in the "Settings" tab of the database
 * sheet instead of here.
 */

var APP_VERSION = '1.0.0';

/** "DATABASE SHEET FOR EXCHANGE RATE WEB PORTAL". A SPREADSHEET_ID script property overrides it. */
var DATABASE_SPREADSHEET_ID = '1xu7O0dDZmUKZ6Kd7HcswG-QQw4ybACEJOixoGGPcw7w';

/**
 * Access is set page by page on the Users & access page. Ticking a page lets
 * the person open it and work on it. "View only" lets them open their ticked
 * pages without adding or changing anything. "Admin" gives every page plus
 * Users & access. The main admin (whoever ran setup first) always has full access.
 */
var PAGES = [
  { key: 'DASHBOARD', label: 'Dashboard', group: 'Exchange rates', help: 'Current ROE, 30 day movement and recent broadcasts.' },
  { key: 'FLUCTUATIONS', label: 'Fluctuations', group: 'Exchange rates', help: 'Rate movement over 7 days to 1 year, highs, lows and biggest moves.' },
  { key: 'PUBLISH', label: 'Publish ROE', group: 'Exchange rates', help: 'Sets the official ROE and emails it. Also resends or voids broadcasts on ROE history.' },
  { key: 'HISTORY', label: 'ROE history', group: 'Exchange rates', help: 'Every past broadcast, with CSV export.' },
  { key: 'BOOK', label: 'Book rates', group: 'Exchange rates', help: 'The Rate Log. Working on it means adding book rates.' },
  { key: 'BSP', label: 'BSP tracking', group: 'Finance', help: 'Coming soon.' },
  { key: 'RECEIVABLES', label: 'Receivables', group: 'Finance', help: 'Coming soon.' },
  { key: 'CREDIT', label: 'Credit control', group: 'Finance', help: 'Coming soon.' },
  { key: 'INVOICES', label: 'Invoices', group: 'Finance', help: 'Coming soon.' },
  { key: 'AUDIT', label: 'Audit log', group: 'Administration', help: 'Sign ins, changes and the email delivery log.' },
  { key: 'SUBSIDIARIES', label: 'Subsidiaries', group: 'Administration', help: 'Subsidiaries, heads of finance, CC lists and test emails.' },
  { key: 'CATEGORIES', label: 'Rate categories', group: 'Administration', help: 'The lines on each broadcast and their order.' },
  { key: 'SETTINGS', label: 'Settings', group: 'Administration', help: 'Company name, logo, broadcast note and email options.' }
];

/** Pages a new person gets unless the admin changes them. */
var DEFAULT_PAGES = ['DASHBOARD', 'FLUCTUATIONS', 'HISTORY', 'BOOK'];

/** Older role names and permission columns, still understood when reading the sheet or the API. */
var LEGACY_ROLES = {
  ADMIN: 'ADMIN',
  RATE_SETTER: DEFAULT_PAGES.concat(['PUBLISH']),
  VIEWER: DEFAULT_PAGES
};
var LEGACY_COLUMNS = [
  ['Can Set Rate', ['PUBLISH']],
  ['Can Manage Subsidiaries', ['SUBSIDIARIES']],
  ['Can View Audit', ['AUDIT']],
  ['Can Edit Settings', ['SETTINGS', 'CATEGORIES']]
];

/** Tabs in the database spreadsheet. Headers are matched by name, so columns can be reordered. */
var SHEETS = {
  SETTINGS: { name: 'Settings', headers: ['Key', 'Value', 'Description'] },
  USERS: {
    name: 'Users',
    headers: ['Email', 'Full Name', 'Job Title', 'Subsidiary', 'Role', 'Pages', 'Admin', 'View Only', 'Blocked', 'Active', 'Created At', 'Created By', 'Last Login']
  },
  SUBSIDIARIES: {
    name: 'Subsidiaries',
    headers: ['Code', 'Subsidiary Name', 'Type', 'Head of Finance', 'Head of Finance Email', 'CC Emails', 'Active', 'Updated At', 'Updated By']
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
  ['LOGO_URL', 'https://lh3.googleusercontent.com/d/15fH9N_jBGV4J219XrEMcwEKCjFYpdlzy', 'Link to the Finchglow Holdings logo. A Google Drive share link works if the file is shared as "Anyone with the link". Used in the portal and in emails.'],
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

/**
 * Group companies from the Finchglow Holdings onboarding guide: 6 subsidiaries and 2 affiliates.
 * Setup adds them without emails; each starts receiving ROE emails once its head of finance email is filled in.
 */
var DEFAULT_SUBSIDIARIES = [
  ['FGT', 'Finchglow Travels', 'Subsidiary', true],
  ['FCM', 'FCM Travel Solutions', 'Subsidiary', true],
  ['FGH', 'Finchglow Holidays', 'Subsidiary', true],
  ['TVD', 'Travelden', 'Subsidiary', true],
  ['LAA', 'Lagos Aviation Academy', 'Subsidiary', true],
  ['FGB', 'Finchglobal', 'Subsidiary', true],
  ['FAIR', 'Finchair', 'Affiliate', false],
  ['PRYSM', 'Prysm Investment', 'Affiliate', false]
];

var SUBSIDIARY_TYPES = ['Subsidiary', 'Affiliate', 'Holding company'];

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
