// Demo data for local preview. Company names are real; people and emails are placeholders (example.com).
import { signIn } from './gas-runtime.mjs';

export const DEMO_USERS = {
  admin: 'cfo@finchglow.com',
  setter: 'fc@example.com',
  viewer: 'hof.fgt@example.com'
};

function ok(res) {
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export function seedDemo(rt) {
  rt.context.setup();
  const admin = signIn(rt, DEMO_USERS.admin);
  ok(rt.call(admin, 'saveUser', { email: DEMO_USERS.admin, name: 'Chief Financial Officer', role: 'ADMIN', subsidiary: 'Holdings' }));
  ok(rt.call(admin, 'saveUser', { email: DEMO_USERS.setter, name: 'Financial Controller', role: 'RATE_SETTER', subsidiary: 'Holdings' }));
  ok(rt.call(admin, 'saveUser', { email: DEMO_USERS.viewer, name: 'Head of Finance (FGT)', role: 'VIEWER', subsidiary: 'Finchglow Travels' }));
  ok(rt.call(admin, 'saveUser', { email: DEMO_USERS.admin, title: 'System Administrator' }));
  ok(rt.call(admin, 'saveUser', { email: DEMO_USERS.setter, title: 'Financial Controller' }));
  ok(rt.call(admin, 'saveUser', { email: DEMO_USERS.viewer, title: 'Head of Finance', pages: { DASHBOARD: true, FLUCTUATIONS: true, HISTORY: true }, viewOnly: true }));
  ok(rt.call(admin, 'saveUser', { email: 'treasury@example.com', name: 'Treasury Desk', title: 'Treasury', subsidiary: 'Holdings', pages: { DASHBOARD: true, FLUCTUATIONS: true, PUBLISH: true, HISTORY: true, BOOK: true, AUDIT: true } }));

  // Placeholder head of finance addresses for the six subsidiaries that setup adds.
  [['FGT', 'Finchglow Travels'], ['FCM', 'FCM Travel Solutions'], ['FGH', 'Finchglow Holidays'], ['TVD', 'Travelden'], ['LAA', 'Lagos Aviation Academy'], ['FGB', 'Finchglobal']]
    .forEach(([code, name]) => ok(rt.call(admin, 'saveSubsidiary', {
      code, name, type: 'Subsidiary', headName: 'Head of Finance (' + code + ')', headEmail: 'hof.' + code.toLowerCase() + '@example.com'
    })));

  // About three months of movement leading into the two real broadcasts from October 2026.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let usd = 1462;
  let gbp = 1965;
  let eur = 1690;
  const start = new Date(Date.UTC(2026, 6, 15, 8, 0));
  for (let day = 0; day < 84; day += 2 + Math.floor(rand() * 3)) {
    const d = new Date(start.getTime() + day * 86400000);
    usd = Math.round(usd - 1 + (rand() - 0.62) * 12);
    gbp = Math.round(gbp - 1.4 + (rand() - 0.62) * 16);
    eur = Math.round(eur - 1.4 + (rand() - 0.62) * 14);
    const when = d.toISOString().slice(0, 10) + 'T' + String(8 + Math.floor(rand() * 2)).padStart(2, '0') + ':0' + Math.floor(rand() * 9);
    publish(rt, admin, when, { usd, gbp, eur });
  }
  publish(rt, admin, '2026-10-09T09:02', null, [
    ['USD', 'Agent / Direct', 1390], ['USD', 'Corporate - Link', 1435], ['USD', 'Corporate - Invoice', 1485],
    ['EUR', 'Immediate payment', 1560], ['EUR', 'Corporate - Invoice', 1655],
    ['GBP', 'Immediate payment', 1850], ['GBP', 'Corporate - Invoice', 1944]
  ]);
  publish(rt, admin, '2026-10-12T08:02', null, [
    ['USD', 'Agent / Direct', 1400], ['USD', 'Corporate - Invoice', 1500],
    ['GBP', 'Immediate payment', 1860], ['GBP', 'Corporate - Invoice', 1960],
    ['EUR', 'Immediate payment', 1560], ['EUR', 'Corporate - Invoice', 1660]
  ], true);
  ok(rt.call(admin, 'logout', {}));
  return { admin };
}

function publish(rt, token, effectiveAt, base, explicit, email = false) {
  const rates = explicit
    ? explicit.map(([currency, category, rate]) => ({ currency, category, rate }))
    : [
        { currency: 'USD', category: 'Agent / Direct', rate: base.usd },
        { currency: 'USD', category: 'Corporate - Link', rate: base.usd + 45 },
        { currency: 'USD', category: 'Corporate - Invoice', rate: base.usd + 95 },
        { currency: 'GBP', category: 'Immediate payment', rate: base.gbp },
        { currency: 'GBP', category: 'Corporate - Invoice', rate: base.gbp + 94 },
        { currency: 'EUR', category: 'Immediate payment', rate: base.eur },
        { currency: 'EUR', category: 'Corporate - Invoice', rate: base.eur + 95 }
      ];
  ok(rt.call(token, 'publish', { effectiveAt, rates, sendEmail: email, confirmLargeChange: true }));
}
