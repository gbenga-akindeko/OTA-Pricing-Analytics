import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, signIn, lastCodeFor } from '../dev/gas-runtime.mjs';

const ADMIN = 'cfo@finchglow.com';
const SETTER = 'fc@finchglow.com';
const VIEWER = 'hof@subsidiary.com';

function ok(res) {
  assert.equal(res.ok, true, res.error);
  return res.data;
}

function fresh() {
  const rt = createRuntime({ effectiveUser: ADMIN });
  rt.context.setup();
  const admin = signIn(rt, ADMIN);
  ok(rt.call(admin, 'saveUser', { email: SETTER, name: 'Financial Controller', role: 'RATE_SETTER' }));
  ok(rt.call(admin, 'saveUser', { email: VIEWER, name: 'Ada Head', role: 'VIEWER', subsidiary: 'Sub A' }));
  ok(rt.call(admin, 'saveSubsidiary', { code: 'SUBA', name: 'Sub A Ltd', headName: 'Ada Head', headEmail: VIEWER, cc: 'deputy@subsidiary.com' }));
  ok(rt.call(admin, 'saveSubsidiary', { code: 'SUBB', name: 'Sub B Ltd', headName: 'Bayo', headEmail: 'bayo@subb.com' }));
  return { rt, admin };
}

const OCT9 = [
  ['USD', 'Agent / Direct', 1390], ['USD', 'Corporate - Link', 1435], ['USD', 'Corporate - Invoice', 1485],
  ['EUR', 'Immediate payment', 1560], ['EUR', 'Corporate - Invoice', 1655],
  ['GBP', 'Immediate payment', 1850], ['GBP', 'Corporate - Invoice', 1944]
].map(([currency, category, rate]) => ({ currency, category, rate }));

const OCT12 = [
  ['USD', 'Agent / Direct', '1,400'], ['USD', 'Corporate - Invoice', '1,500'],
  ['GBP', 'Immediate payment', '1,860'], ['GBP', 'Corporate - Invoice', '1,960'],
  ['EUR', 'Immediate payment', '1,560'], ['EUR', 'Corporate - Invoice', '1,660']
].map(([currency, category, rate]) => ({ currency, category, rate }));

test('setup creates every tab, default categories, seeded book rates and the first admin', () => {
  const rt = createRuntime({ effectiveUser: ADMIN });
  rt.context.setup();
  for (const name of ['Settings', 'Users', 'Subsidiaries', 'Rate Categories', 'ROE Publications', 'ROE Log', 'Rate Log', 'Email Log', 'Audit Log']) {
    assert.ok(rt.sheet(name), `missing tab ${name}`);
  }
  assert.equal(rt.sheet('Rate Categories').toObjects().length, 7);
  assert.equal(rt.sheet('Rate Log').toObjects().length, 4);
  const subs = rt.sheet('Subsidiaries').toObjects();
  assert.equal(subs.filter((r) => r.Type === 'Subsidiary').length, 6);
  assert.equal(subs.filter((r) => r.Type === 'Affiliate').length, 2);
  assert.ok(subs.some((r) => r['Subsidiary Name'] === 'Travelden'));
  const users = rt.sheet('Users').toObjects();
  assert.equal(users[0].Email, ADMIN);
  assert.equal(users[0].Role, 'ADMIN');
  rt.context.setup(); // running again must not duplicate anything
  assert.equal(rt.sheet('Rate Categories').toObjects().length, 7);
  assert.equal(rt.sheet('Users').toObjects().length, 1);
  assert.equal(rt.sheet('Subsidiaries').toObjects().length, 8);
});

test('preloaded companies without a head of finance email are skipped until one is added', () => {
  const rt = createRuntime({ effectiveUser: ADMIN });
  rt.context.setup();
  const admin = signIn(rt, ADMIN);
  const res = ok(rt.call(admin, 'publish', { rates: OCT9, sendEmail: true }));
  assert.equal(res.email.status, 'NO RECIPIENTS');
  ok(rt.call(admin, 'saveSubsidiary', { code: 'TVD', name: 'Travelden', type: 'Subsidiary', headName: 'TVD HoF', headEmail: 'hof@travelden.example' }));
  const again = ok(rt.call(admin, 'publish', { rates: OCT12, sendEmail: true }));
  assert.equal(again.email.status, 'SENT 1/1');
  assert.equal(rt.sheet('Subsidiaries').toObjects().filter((r) => r.Code === 'TVD').length, 1);
});

test('the Drive share link for the logo becomes a direct image link', () => {
  const { rt, admin } = fresh();
  const cfg = ok(rt.call(null, 'config'));
  assert.equal(cfg.logoUrl, 'https://lh3.googleusercontent.com/d/15fH9N_jBGV4J219XrEMcwEKCjFYpdlzy');
  assert.equal(cfg.logoIsDefault, true);
  ok(rt.call(admin, 'saveSettings', { values: { LOGO_URL: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing' } }));
  assert.equal(ok(rt.call(null, 'config')).logoUrl, 'https://lh3.googleusercontent.com/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
  assert.equal(ok(rt.call(null, 'config')).logoIsDefault, false);
});

test('sign in: unknown emails get the same reply and no email', () => {
  const { rt } = fresh();
  const before = rt.outbox.length;
  const r = ok(rt.call(null, 'requestCode', { email: 'stranger@gmail.com' }));
  assert.match(r.message, /If this email is registered/);
  assert.equal(rt.outbox.length, before);
  const audit = rt.sheet('Audit Log').toObjects();
  assert.equal(audit.at(-1).Action, 'LOGIN_CODE_DENIED');
  assert.equal(audit.at(-1).Category, 'ACCESS');
});

test('sign in: wrong codes are counted and lock the code after five tries', () => {
  const { rt } = fresh();
  ok(rt.call(null, 'requestCode', { email: VIEWER }));
  const code = lastCodeFor(rt, VIEWER);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = rt.call(null, 'verifyCode', { email: VIEWER, code: wrong });
    assert.equal(r.code, 'BAD_CODE');
  }
  // The right code no longer works once locked.
  assert.equal(rt.call(null, 'verifyCode', { email: VIEWER, code }).code, 'BAD_CODE');
  const actions = rt.sheet('Audit Log').toObjects().map((r) => r.Action);
  assert.equal(actions.filter((a) => a === 'LOGIN_FAILED').length, 6);
  assert.ok(actions.includes('LOGIN_LOCKED'));
});

test('sign in: codes expire after 10 minutes and sessions after 4 idle hours', () => {
  const { rt } = fresh();
  ok(rt.call(null, 'requestCode', { email: VIEWER }));
  const code = lastCodeFor(rt, VIEWER);
  rt.advance(11 * 60 * 1000);
  assert.equal(rt.call(null, 'verifyCode', { email: VIEWER, code }).code, 'BAD_CODE');

  const token = signIn(rt, VIEWER);
  ok(rt.call(token, 'current'));
  rt.advance(4 * 3600 * 1000 + 1000);
  assert.equal(rt.call(token, 'current').code, 'AUTH');
});

test('roles: viewers cannot publish and setters cannot manage users; attempts are audited', () => {
  const { rt } = fresh();
  const viewer = signIn(rt, VIEWER);
  const setter = signIn(rt, SETTER);
  assert.equal(rt.call(viewer, 'publish', { rates: OCT9 }).code, 'FORBIDDEN');
  assert.equal(rt.call(setter, 'saveUser', { email: 'x@y.com', name: 'X', role: 'ADMIN' }).code, 'FORBIDDEN');
  assert.equal(rt.call(setter, 'audit').code, 'FORBIDDEN');
  assert.equal(rt.call(null, 'current').code, 'AUTH');
  assert.equal(rt.call('not-a-real-token-but-long-enough-000000', 'current').code, 'AUTH');
  const denied = rt.sheet('Audit Log').toObjects().filter((r) => r.Action === 'ACCESS_DENIED');
  assert.equal(denied.length, 3);
  assert.match(denied[0].Details, /publish/);
});

test('roles: disabling a user ends their session straight away', () => {
  const { rt, admin } = fresh();
  const viewer = signIn(rt, VIEWER);
  ok(rt.call(viewer, 'current'));
  ok(rt.call(admin, 'saveUser', { email: VIEWER, name: 'Ada Head', role: 'VIEWER', active: false }));
  assert.equal(rt.call(viewer, 'current').code, 'AUTH');
  assert.equal(rt.sheet('Audit Log').toObjects().at(-1).Action, 'SESSION_REVOKED');
});

test('the main admin always keeps full access and cannot be changed or removed', () => {
  const { rt, admin } = fresh();
  // Name and title changes are fine, but the access stays full whatever is sent.
  ok(rt.call(admin, 'saveUser', { email: ADMIN, name: 'Chief Financial Officer', title: 'CFO', pages: {}, blocked: true }));
  const boot = ok(rt.call(admin, 'bootstrap')).user;
  assert.equal(boot.name, 'Chief Financial Officer');
  assert.equal(boot.title, 'CFO');
  assert.equal(boot.admin, true);
  assert.equal(rt.call(admin, 'removeUser', { email: ADMIN }).code, 'VALIDATION');

  ok(rt.call(admin, 'saveUser', { email: SETTER, admin: true }));
  const fcAdmin = signIn(rt, SETTER);
  ok(rt.call(fcAdmin, 'saveUser', { email: ADMIN, pages: { DASHBOARD: true } }));
  assert.equal(ok(rt.call(admin, 'bootstrap')).user.access, 'Main admin');
  assert.equal(rt.call(fcAdmin, 'removeUser', { email: ADMIN }).code, 'VALIDATION');
  // Nobody can take away their own admin access or remove themselves.
  assert.equal(rt.call(fcAdmin, 'saveUser', { email: SETTER, pages: { DASHBOARD: true } }).code, 'VALIDATION');
  assert.equal(rt.call(fcAdmin, 'removeUser', { email: SETTER }).code, 'VALIDATION');
  assert.equal(ok(rt.call(admin, 'users')).users[0].isMainAdmin, true);
});

test('access is a tick box per page, and every page checks its own box', () => {
  const { rt, admin } = fresh();
  const AUDITOR = 'auditor@finchglow.com';
  ok(rt.call(admin, 'saveUser', { email: AUDITOR, title: 'Internal Auditor', pages: { AUDIT: true, HISTORY: true } }));
  const a = signIn(rt, AUDITOR);
  const me = ok(rt.call(a, 'bootstrap')).user;
  assert.equal(me.name, 'Auditor'); // filled in from the email when left blank
  assert.equal(me.roleLabel, 'Internal Auditor');
  assert.equal(me.access, 'ROE history, Audit log');
  ok(rt.call(a, 'audit', {}));
  ok(rt.call(a, 'history', {}));
  for (const action of ['current', 'fluctuations', 'bookRates', 'subsidiaries', 'settings', 'categories', 'users']) {
    assert.equal(rt.call(a, action, {}).code, 'FORBIDDEN', action);
  }

  // Ticking a page lets them work on it; changes apply on the next request and are audited.
  ok(rt.call(admin, 'saveUser', { email: AUDITOR, pages: { PUBLISH: true, BOOK: true } }));
  ok(rt.call(a, 'publish', { rates: OCT9 }));
  ok(rt.call(a, 'addBookRate', { date: '2026-10-14', usd: 1350, eur: 1520, gbp: 1790 }));
  assert.equal(rt.call(a, 'audit', {}).code, 'FORBIDDEN');
  const change = rt.sheet('Audit Log').toObjects().filter((r) => r.Action === 'UPDATE_USER').at(-1);
  assert.match(change.Details, /ROE history, Audit log -> Publish ROE, Book rates/);
});

test('view only opens the ticked pages but blocks every change', () => {
  const { rt, admin } = fresh();
  ok(rt.call(admin, 'saveUser', { email: SETTER, pages: { PUBLISH: true, BOOK: true, SUBSIDIARIES: true, SETTINGS: true, DASHBOARD: true }, viewOnly: true }));
  const v = signIn(rt, SETTER);
  ok(rt.call(v, 'current'));
  ok(rt.call(v, 'recipients'));
  ok(rt.call(v, 'bookRates'));
  ok(rt.call(v, 'subsidiaries'));
  ok(rt.call(v, 'settings'));
  assert.equal(rt.call(v, 'publish', { rates: OCT9 }).code, 'FORBIDDEN');
  assert.equal(rt.call(v, 'addBookRate', { date: '2026-10-14', usd: 1350, eur: 1, gbp: 1 }).code, 'FORBIDDEN');
  assert.equal(rt.call(v, 'saveSubsidiary', { code: 'FGT', name: 'x', headEmail: 'a@b.com' }).code, 'FORBIDDEN');
  assert.equal(rt.call(v, 'saveSettings', { values: {} }).code, 'FORBIDDEN');
  assert.match(rt.sheet('Audit Log').toObjects().at(-1).Details, /view only/);
  assert.match(ok(rt.call(v, 'bootstrap')).user.access, /\(view only\)$/);
});

test('admin gives every page, and new people start with the default pages', () => {
  const { rt, admin } = fresh();
  ok(rt.call(admin, 'saveUser', { email: 'new.person@finchglow.com' }));
  const n = signIn(rt, 'new.person@finchglow.com');
  assert.equal(ok(rt.call(n, 'bootstrap')).user.access, 'Dashboard, Fluctuations, ROE history, Book rates');
  ok(rt.call(admin, 'saveUser', { email: 'new.person@finchglow.com', admin: true, viewOnly: true }));
  const u = ok(rt.call(n, 'bootstrap')).user;
  assert.equal(u.admin, true);
  assert.equal(u.viewOnly, false); // admin overrides view only
  ok(rt.call(n, 'users'));
  // Details only: keeps their access.
  ok(rt.call(admin, 'saveUser', { email: 'new.person@finchglow.com', title: 'Treasury Lead', subsidiary: 'Travelden' }));
  assert.equal(ok(rt.call(n, 'bootstrap')).user.admin, true);
});

test('blocking and removing people', () => {
  const { rt, admin } = fresh();
  const viewer = signIn(rt, VIEWER);
  ok(rt.call(admin, 'saveUser', { email: VIEWER, pages: { DASHBOARD: true }, blocked: true }));
  assert.equal(rt.call(viewer, 'current').code, 'AUTH');
  const before = rt.outbox.length;
  ok(rt.call(null, 'requestCode', { email: VIEWER }));
  assert.equal(rt.outbox.length, before, 'blocked people get no sign in code');

  ok(rt.call(admin, 'saveUser', { email: VIEWER, pages: { DASHBOARD: true }, blocked: false }));
  ok(rt.call(admin, 'removeUser', { email: VIEWER }));
  assert.ok(!ok(rt.call(admin, 'users')).users.some((u) => u.email === VIEWER));
  assert.equal(rt.sheet('Audit Log').toObjects().at(-1).Action, 'REMOVE_USER');
});

test('rows written with the old Role column still work', () => {
  const { rt } = fresh();
  const sheet = rt.sheet('Users');
  const headers = sheet.getDataRange().getValues()[0];
  const row = headers.map((h) => ({ Email: 'legacy@finchglow.com', 'Full Name': 'Legacy FC', Role: 'RATE_SETTER', Active: true }[h] ?? ''));
  sheet.appendRow(row);
  const t = signIn(rt, 'legacy@finchglow.com');
  assert.equal(ok(rt.call(t, 'bootstrap')).user.access, 'Dashboard, Fluctuations, Publish ROE, ROE history, Book rates');
  ok(rt.call(t, 'publish', { rates: OCT9 }));
});

test('publishing saves the broadcast, emails each head of finance and shows changes', () => {
  const { rt } = fresh();
  const setter = signIn(rt, SETTER);
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-09T09:02', rates: OCT9, sendEmail: false }));
  rt.outbox.length = 0;
  const res = ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-12T08:02', rates: OCT12, sendEmail: true }));
  assert.equal(res.email.status, 'SENT 2/2');

  const sentTo = rt.outbox.map((m) => m.to).sort();
  assert.deepEqual(sentTo, ['bayo@subb.com', VIEWER]);
  const ada = rt.outbox.find((m) => m.to === VIEWER);
  assert.equal(ada.cc, 'deputy@subsidiary.com');
  assert.equal(ada.subject, '[ROE] ROE for 12/10/26 @ 08:02');
  assert.match(ada.body, /^Dear Ada Head,/);
  assert.ok(ada.htmlBody.includes('Dear Ada Head'));

  const cur = ok(rt.call(setter, 'current'));
  assert.equal(cur.latest.effectiveLabel, '12/10/26 @ 08:02');
  const usd = cur.groups.find((g) => g.currency === 'USD');
  assert.deepEqual(usd.lines.map((l) => [l.category, l.rate, l.change]), [
    ['Agent / Direct', 1400, 10],
    ['Corporate - Link', 1435, null], // carried over from 09/10, it was not in the 12/10 broadcast
    ['Corporate - Invoice', 1500, 15]
  ]);
  assert.equal(rt.sheet('ROE Log').toObjects().length, 13);
  assert.equal(rt.sheet('Email Log').toObjects().length, 2);
});

test('the email text matches the WhatsApp broadcast layout exactly', () => {
  const { rt } = fresh();
  const setter = signIn(rt, SETTER);
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-12T08:02', rates: OCT12, sendEmail: true }));
  const pubs = rt.context.loadPublications_();
  const text = rt.context.buildRoeText_(rt.context.serializePublication_(pubs[0], {}), rt.context.orderedGroups_(pubs[0]));
  assert.equal(text, [
    'ROE for 12/10/26 @08:02',
    '',
    'USD ROE:',
    '1,400 - (Agent / Direct)',
    '1,500 - (Corporate - Invoice)',
    '',
    'POUNDS ROE:',
    '1,860 - (Immediate payment)',
    '1,960 - (Corporate - Invoice)',
    '',
    'EURO ROE:',
    '1,560 - (Immediate payment)',
    '1,660 - (Corporate - Invoice)',
    '',
    'Note: This rate is ONLY VALID for a limited time. Pls call to ask in 15-mins if your client is yet to pay'
  ].join('\n'));
});

test('publishing rejects bad input', () => {
  const { rt } = fresh();
  const setter = signIn(rt, SETTER);
  const bad = (rates, extra = {}) => rt.call(setter, 'publish', { rates, ...extra }).code;
  assert.equal(bad([]), 'VALIDATION');
  assert.equal(bad([{ currency: 'USD', category: 'Agent / Direct', rate: '-5' }]), 'VALIDATION');
  assert.equal(bad([{ currency: 'USD', category: 'Agent / Direct', rate: 'abc' }]), 'VALIDATION');
  assert.equal(bad([{ currency: 'JPY', category: 'Agent / Direct', rate: 10 }]), 'VALIDATION');
  assert.equal(bad([{ currency: 'USD', category: 'Agent / Direct', rate: 1 }, { currency: 'usd', category: 'Agent / Direct', rate: 2 }]), 'VALIDATION');
  assert.equal(bad(OCT9, { effectiveAt: 'yesterday' }), 'VALIDATION');
  assert.equal(rt.sheet('ROE Publications').toObjects().length, 0);
});

test('a rate that jumps more than 10% needs confirmation, and a double submit is blocked', () => {
  const { rt } = fresh();
  const setter = signIn(rt, SETTER);
  ok(rt.call(setter, 'publish', { rates: OCT9 }));
  const typo = [{ currency: 'USD', category: 'Agent / Direct', rate: 14000 }];
  const r = rt.call(setter, 'publish', { rates: typo, requestId: 'abc' });
  assert.equal(r.code, 'CONFIRM_REQUIRED');
  assert.match(r.extra.warnings[0], /USD Agent \/ Direct: 1,390 to 14,000/);
  ok(rt.call(setter, 'publish', { rates: typo, requestId: 'abc', confirmLargeChange: true }));
  assert.equal(rt.call(setter, 'publish', { rates: typo, requestId: 'abc', confirmLargeChange: true }).code, 'DUPLICATE');
});

test('voiding a publication brings back the previous rates', () => {
  const { rt } = fresh();
  const setter = signIn(rt, SETTER);
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-09T09:02', rates: OCT9 }));
  const second = ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-12T08:02', rates: OCT12 }));
  assert.equal(rt.call(setter, 'voidPublication', { id: second.id }).code, 'VALIDATION'); // reason required
  ok(rt.call(setter, 'voidPublication', { id: second.id, reason: 'Typo' }));
  const cur = ok(rt.call(setter, 'current'));
  assert.equal(cur.latest.effectiveLabel, '09/10/26 @ 09:02');
  assert.equal(cur.groups[0].lines[0].rate, 1390);
  assert.equal(rt.call(setter, 'resend', { id: second.id }).code, 'VALIDATION');
  assert.ok(rt.sheet('ROE Log').toObjects().filter((r) => r.Status === 'VOID').length === 6);
});

test('history filters by date and works out the change against the previous rate', () => {
  const { rt } = fresh();
  const viewer = signIn(rt, VIEWER);
  const setter = signIn(rt, SETTER);
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-09T09:02', rates: OCT9 }));
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-12T08:02', rates: OCT12 }));
  const all = ok(rt.call(viewer, 'history', { from: '2026-10-01', to: '2026-10-31' }));
  assert.equal(all.publications.length, 2);
  const gbp = all.publications[0].rates.find((r) => r.currency === 'GBP' && r.category === 'Immediate payment');
  assert.deepEqual([gbp.previous, gbp.change], [1850, 10]);
  const one = ok(rt.call(viewer, 'history', { from: '2026-10-10', to: '2026-10-31' }));
  assert.equal(one.publications.length, 1);
});

test('fluctuations: start, current, high, low, moves and markup over the book rate', () => {
  const { rt } = fresh();
  const setter = signIn(rt, SETTER);
  const usd = (rate) => [{ currency: 'USD', category: 'Agent / Direct', rate }];
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-08-01T09:00', rates: usd(1380) })); // before the window
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-01T09:00', rates: usd(1420) }));
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-05T09:00', rates: usd(1370) }));
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-12T08:02', rates: usd(1400), confirmLargeChange: true }));
  const fl = ok(rt.call(setter, 'fluctuations', { days: 30 }));
  assert.equal(fl.labels.length, 30);
  const s = fl.groups.find((g) => g.currency === 'USD').series[0];
  assert.equal(s.open, 1380);
  assert.equal(s.current, 1400);
  assert.equal(s.change, 20);
  assert.equal(s.high, 1420);
  assert.equal(s.low, 1370);
  assert.equal(s.moves, 3);
  assert.equal(s.biggestMove.change, -50);
  assert.equal(s.closes[0], 1380);
  assert.equal(s.closes.at(-1), 1400);
  // Book rate seeded from the workbook: 1,348 on 06/10/2026.
  assert.equal(s.markupOverBook, 3.86);
});

test('book rates use the same ROUNDDOWN cross-rate maths as the workbook', () => {
  const { rt } = fresh();
  const setter = signIn(rt, SETTER);
  const r = ok(rt.call(setter, 'addBookRate', { date: '2026-10-14', usd: '1348', usdToEur: '0.88858', usdToGbp: '0.75499' }));
  assert.equal(r.eur, 1517.02);
  assert.equal(r.gbp, 1785.45);
  const book = ok(rt.call(setter, 'bookRates'));
  assert.equal(book.entries[0].date, '2026-10-14');
  assert.equal(book.entries.length, 5);
});

test('text that looks like a formula is stored as plain text', () => {
  const { rt } = fresh();
  const setter = signIn(rt, SETTER);
  ok(rt.call(setter, 'publish', { rates: OCT9, note: '=IMPORTXML("http://evil")' }));
  const stored = rt.context.readTable_(rt.context.SHEETS.PUBLICATIONS)[0];
  assert.equal(stored.Note, '=IMPORTXML("http://evil")'); // apostrophe prefix was added and removed by Sheets
  const cur = ok(rt.call(setter, 'current'));
  assert.equal(cur.latest.note, '=IMPORTXML("http://evil")');
});

test('email failures are logged per subsidiary and do not stop the others', () => {
  const { rt } = fresh();
  const setter = signIn(rt, SETTER);
  rt.mail.failFor.add('bayo@subb.com');
  const res = ok(rt.call(setter, 'publish', { rates: OCT9, sendEmail: true }));
  assert.equal(res.email.status, 'PARTIAL 1/2');
  const log = rt.sheet('Email Log').toObjects();
  assert.deepEqual(log.map((l) => l.Status).sort(), ['FAILED', 'SENT']);
  assert.equal(rt.sheet('ROE Publications').toObjects()[0]['Email Status'], 'PARTIAL 1/2');
});

test('audit log: filters by type and records rate changes as old -> new', () => {
  const { rt, admin } = fresh();
  const setter = signIn(rt, SETTER);
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-09T09:02', rates: OCT9 }));
  ok(rt.call(setter, 'publish', { effectiveAt: '2026-10-12T08:02', rates: OCT12, sendEmail: true }));
  const access = ok(rt.call(admin, 'audit', { category: 'ACCESS' }));
  assert.ok(access.entries.length > 0 && access.entries.every((e) => e.category === 'ACCESS'));
  const changes = ok(rt.call(admin, 'audit', { category: 'CHANGE', q: 'PUBLISH' }));
  const latest = JSON.parse(changes.entries[0].details);
  assert.equal(latest.effective, '12/10/26 08:02');
  assert.ok(latest.rates.includes('USD Agent / Direct: 1,390 -> 1,400'));
  assert.ok(latest.rates.includes('EUR Immediate payment: 1,560 (no change)'));
  const emails = ok(rt.call(admin, 'audit', { category: 'EMAIL' }));
  assert.equal(emails.entries[0].action, 'EMAIL_ROE');
  assert.ok(access.summary.logins >= 2);
});

test('settings: only known keys are saved, links must be https, and changes are audited', () => {
  const { rt, admin } = fresh();
  assert.equal(rt.call(admin, 'saveSettings', { values: { LOGO_URL: 'http://insecure/logo.png' } }).code, 'VALIDATION');
  const r = ok(rt.call(admin, 'saveSettings', { values: { LOGO_URL: 'https://example.com/logo.png', NOT_A_SETTING: 'x', VALIDITY_NOTE: 'Valid 15 mins' } }));
  assert.deepEqual(r.changed.sort(), ['LOGO_URL', 'VALIDITY_NOTE']);
  assert.equal(ok(rt.call(null, 'config')).logoUrl, 'https://example.com/logo.png');
  const setter = signIn(rt, SETTER);
  ok(rt.call(setter, 'publish', { rates: OCT9, sendEmail: true }));
  const html = rt.outbox.at(-1).htmlBody;
  assert.ok(html.includes('src="https://example.com/logo.png"'));
  assert.ok(html.includes('Note: Valid 15 mins'));
});

test('subsidiaries validate emails and test emails reach the head of finance', () => {
  const { rt, admin } = fresh();
  assert.equal(rt.call(admin, 'saveSubsidiary', { code: 'X1', name: 'X', headEmail: 'not-an-email' }).code, 'VALIDATION');
  assert.equal(rt.call(admin, 'saveSubsidiary', { code: 'X1', name: 'X', headEmail: 'a@b.com', cc: 'ok@b.com, bad' }).code, 'VALIDATION');
  const r = ok(rt.call(admin, 'testEmail', { code: 'SUBA' }));
  assert.equal(r.to, VIEWER);
  assert.match(rt.outbox.at(-1).subject, /Test email/);
});
