import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildBundle } from '../dev/bundle.mjs';
import { createRuntime, signIn } from '../dev/gas-runtime.mjs';

test('dist/ matches apps-script/ (run `npm run bundle` after changing the portal)', () => {
  const built = buildBundle();
  for (const [name, content] of Object.entries(built)) {
    assert.equal(fs.readFileSync(new URL('../dist/' + name, import.meta.url), 'utf8'), content, `dist/${name} is out of date`);
  }
});

test('the single-file Code.gs works on its own', () => {
  const rt = createRuntime({ source: buildBundle()['Code.gs'] });
  rt.context.setup();
  const token = signIn(rt, 'cfo@finchglow.com');
  const r = rt.call(token, 'publish', { rates: [{ currency: 'USD', category: 'Agent / Direct', rate: 1400 }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(rt.call(token, 'current').data.latest.rates[0].rate, 1400);
});

test('Index.html has the styles, logo and client code inlined', () => {
  const html = buildBundle()['Index.html'];
  assert.ok(html.includes('window.EMBEDDED_LOGO = \'data:image/png;base64,'));
  assert.ok(html.includes('--fg-cyan'));
  assert.ok(html.includes("api('config')"));
  assert.ok(!html.includes('<?'));
});
