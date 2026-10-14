// Local preview of the portal: serves the real HTML and runs the real server code
// against an in-memory sheet. Sign in codes are printed here instead of emailed.
//   npm run dev  ->  http://localhost:8080   (sign in as cfo@finchglow.com)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRuntime, SCRIPT_DIR } from './gas-runtime.mjs';
import { seedDemo } from './seed.mjs';

const PORT = Number(process.env.PORT) || 8080;
const rt = createRuntime();
if (!process.argv.includes('--empty')) seedDemo(rt);

const printed = new Set();
function printCodes() {
  rt.outbox.forEach((m, i) => {
    if (printed.has(i)) return;
    printed.add(i);
    if (/sign in code/.test(m.subject)) console.log(`[dev] sign in code for ${m.to}: ${/(\d{6})/.exec(m.subject)[1]}`);
    else if (process.argv.includes('--verbose')) console.log(`[dev] email to ${m.to}: ${m.subject}`);
  });
}
printCodes();

const SHIM = `<script>
  window.google = { script: { get run() {
    var ok = function () {}, bad = function () {};
    var runner = {
      withSuccessHandler: function (f) { ok = f; return runner; },
      withFailureHandler: function (f) { bad = f; return runner; },
      api: function () {
        fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: [].slice.call(arguments) }) })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(ok, bad);
      }
    };
    return runner;
  } } };
</script>`;

function renderIndex() {
  let html = fs.readFileSync(path.join(SCRIPT_DIR, 'Index.html'), 'utf8');
  html = html.replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (m, name) => fs.readFileSync(path.join(SCRIPT_DIR, name + '.html'), 'utf8'));
  // Serve Chart.js locally so the preview works offline; production loads the same version from cdnjs.
  html = html.replace(/<script src="https:\/\/cdnjs[^"]*chart\.umd\.min\.js"><\/script>/, '<script src="/dev/chart.js"></script>');
  return html.replace('<script src="/dev/chart.js">', SHIM + '\n  <script src="/dev/chart.js">');
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderIndex());
  }
  if (req.method === 'GET' && req.url === '/dev/chart.js') {
    const file = path.join(SCRIPT_DIR, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('// run npm install for charts'); }
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'GET' && req.url === '/dev/outbox') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rt.outbox.map((m) => ({ to: m.to, cc: m.cc, subject: m.subject, html: m.htmlBody, text: m.body }))));
  }
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { args } = JSON.parse(body);
        const out = rt.call(...args);
        printCodes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        console.error(e);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(e.message || e));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`[dev] Finance Portal preview on http://localhost:${PORT}  (sign in as cfo@finchglow.com)`));
