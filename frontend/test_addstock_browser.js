// Renders the real dashboard in headless Chrome, opens the real Add Stock modal,
// and measures the resulting layout. Reports what the checks in
// frontend/test_render.js assert, but from an actual browser with real CSS and
// real geometry rather than a regex over a template string.
//
// Usage: node test_addstock_browser.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(__dirname, 'SupplyIQ-Grocery-Dashboard.html');
// The copy must live beside the original: it references js/api.js and
// public/login.html by relative path, and a file in %TEMP% would load no script
// at all and then navigate to a login page that is not there.
const PAGE = path.join(__dirname, '.tmp-addstock-verify.html');
const FRAME = path.join(__dirname, '.tmp-addstock-frame.html');

const EXPECT = [
  ['Product', 'ap'], ['Supplier', 'asup'], ['Date', 'adate'], ['Quantity', 'aq'],
  ['Purchase Price / Unit', 'auc'], ['Selling Price / Unit', 'asp'], ['Invoice No.', 'ainv'],
];

// A session so the page does not bounce to the login screen, and a fetch stub so
// boot never waits on the API. The modal under test never calls the API.
const shim = `<script>
localStorage.setItem('siq_session', JSON.stringify({
  token: 'verify-token', storeId: 'VERIFY', name: 'Verify', email: 'v@test.local'
}));
window.fetch = () => Promise.resolve({ ok: true, status: 200,
  json: () => Promise.resolve({}), text: () => Promise.resolve('{}') });
</script>`;

const probe = `<script>
// This script is injected into the page, so it shares the global scope with the
// dashboard. Nothing here may redeclare a name the app already owns (notably $),
// or the whole script fails to parse and silently never runs.
(async () => {
  const out = { errors: [], steps: [] };
  window.onerror = (m) => out.errors.push(String(m));
  const q = (s) => document.querySelector(s);
  // Injected from the Node side: the expected labels and input ids must be the
  // single source of truth for both the DOM checks and the printed order.
  const EXPECT = ${JSON.stringify(EXPECT)};
  const finish = (o) => {
    // The page is loaded inside an iframe sized to the viewport under test (see
    // below), so the result is handed to the parent to be dumped. Chrome refuses
    // to make a window narrower than 504px, and an iframe is the only way to get
    // a true phone-width layout out of --dump-dom.
    if (window.parent && window.parent !== window) window.parent.postMessage(o, '*');
    const d = document.createElement('pre');
    d.id = 'verify-result';
    d.textContent = JSON.stringify(o, null, 1);
    document.body.appendChild(d);
  };
  const waitFor = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); }
    return false;
  };

  try {
  if (!await waitFor(() => q('#addS'))) {
    // renderUp() only runs once the dashboard has loaded its data. When boot is
    // offline or slow the button is simply not there yet, so drive the real
    // renderer directly instead of giving up: it is the same function the page
    // calls, which is what this check is about.
    if (typeof window.renderUp === 'function') {
      try { window.renderUp(); out.steps.push('drove renderUp() directly'); }
      catch (e) { out.steps.push('renderUp() threw: ' + e.message); return finish(out); }
    }
    if (!q('#addS')) {
      out.steps.push('FAIL #addS never rendered (at ' + location.href + ')');
      return finish(out);
    }
  }
  q('#addS').click();
  if (!await waitFor(() => q('#addGo'))) {
    out.steps.push('FAIL the Add Stock modal never opened');
    return finish(out);
  }

  const labels = [...document.querySelectorAll('#modc label')].map(l => l.textContent.trim());
  const ids = EXPECT.map(([, id]) => id);

  // 1. every field present exactly once, in order
  const found = ids.filter(id => document.querySelectorAll('#modc [id="' + id + '"]').length === 1);
  out.fieldsOnce = found.length === ids.length;
  out.orderOk = ids.every((id, i) => {
    const all = [...document.querySelectorAll('#modc .fld > *')].map(e => e.id || e.tagName);
    return all.indexOf(id) > -1;
  });
  out.renderOrder = [...document.querySelectorAll('#modc .fld')].map(
    f => (f.querySelector('label') || {}).textContent);

  // 2. no duplicated labels / inputs / buttons
  out.labels = labels;
  out.dupLabels = labels.filter((l, i) => labels.indexOf(l) !== i);
  out.dupInputs = ids.filter(id => document.querySelectorAll('#modc [id="' + id + '"]').length > 1);
  const btns = [...document.querySelectorAll('#modc button')].map(b => b.textContent.trim());
  out.buttons = btns;
  out.addGoCount = document.querySelectorAll('#modc #addGo').length;

  // 3. geometry: label directly above its input, nothing overlapping, one column
  const geo = [];
  for (const [label, id] of EXPECT) {
    const l = document.querySelector('#modc label[for="' + id + '"]');
    const i = document.querySelector('#modc [id="' + id + '"]');
    if (!l || !i) { geo.push({ label, missing: true }); continue; }
    const a = l.getBoundingClientRect(), b = i.getBoundingClientRect();
    geo.push({
      label, id,
      labelText: l.textContent.trim(),
      labelTop: Math.round(a.top), labelBottom: Math.round(a.bottom),
      inputTop: Math.round(b.top), inputBottom: Math.round(b.bottom),
      gap: Math.round(b.top - a.bottom),
      left: Math.round(b.left), width: Math.round(b.width),
    });
  }
  out.geo = geo;
  out.labelsAboveInputs = geo.every(g => !g.missing && g.gap >= 0);
  // Every input must start on the same left edge: that is what proves one column
  // rather than a two-up grid.
  const lefts = [...new Set(geo.map(g => g.left))];
  out.singleColumn = lefts.length === 1;
  out.lefts = lefts;

  // 4. vertical order, no overlap, and each label grouped with its own input
  let prevBottom = null, overlap = [], tight = [];
  for (const g of geo) {
    if (g.missing) continue;
    const b = document.querySelector('#modc [id="' + g.id + '"]').getBoundingClientRect();
    if (prevBottom !== null && b.top < prevBottom) overlap.push(g.label);
    prevBottom = b.bottom;
  }
  out.overlaps = overlap;
  out.minGap = Math.min(...geo.filter(g => !g.missing).map(g => g.gap));
  // A label must sit closer to its own input than that input sits to the next
  // label, otherwise the labels look like they belong to the field above and the
  // form reads as one run-on block — which is what this form is fixing.
  tight = [];
  for (let i = 0; i < geo.length - 1; i++) {
    const own = geo[i], next = geo[i + 1];
    if (own.missing || next.missing) continue;
    const between = geo[i + 1].labelTop - geo[i].inputBottom;
    if (between <= own.gap) tight.push(own.labelText + ' -> ' + next.labelText + ' (' + between + 'px)');
  }
  out.badGrouping = tight;
  out.spaced = out.minGap >= 4 && tight.length === 0;

  // 5. no horizontal overflow: on a narrow screen the modal is capped at 92vw,
  // so every input must fit inside it rather than spill out of the dialog.
  const card = document.querySelector('#mod .card') || q('#modc');
  const cr = card.getBoundingClientRect();
  out.modalWidth = Math.round(cr.width);
  out.viewport = { w: innerWidth, h: innerHeight };
  out.fitsViewport = cr.right <= innerWidth + 1 && cr.left >= -1;
  out.overflowing = geo.filter(g => !g.missing).filter(g => {
    const b = document.querySelector('#modc [id="' + g.id + '"]').getBoundingClientRect();
    return b.right > cr.right + 1 || b.left < cr.left - 1;
  }).map(g => g.labelText);
  out.docScrollsSideways = document.documentElement.scrollWidth > innerWidth + 1;

  finish(out);

  } catch (e) {
    out.steps.push('probe threw: ' + (e && e.message));
    finish(out);
  }
})();
</script>`;

(async () => {

let html = fs.readFileSync(SRC, 'utf8');
html = html.replace(/<link rel="icon"[^>]*>/, '');
html = html.replace('<head>', '<head>' + shim);
html = html.replace('</body>', probe + '</body>');
fs.writeFileSync(PAGE, html);

// Loaded over HTTP, not file://, because the dashboard keeps its session in
// localStorage and browsers refuse localStorage on a file:// origin — which sent
// the page straight to the login screen and left nothing to measure.
const PORT = 3000;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const up = () => new Promise((resolve) => {
  const req = http.get(`${ORIGIN}/SupplyIQ-Grocery-Dashboard.html`, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.setTimeout(1500, () => { req.destroy(); resolve(false); });
});

// The page has to be served over HTTP (localStorage is refused on file://), so
// start the frontend server if it is not already up and stop it again afterwards.
async function ensureServer() {
  if (await up()) return null;
  const child = spawn(process.execPath, [path.join(__dirname, 'serve.js')], {
    cwd: __dirname, stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 40 && !(await up()); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await up())) {
    child.kill();
    console.error(`could not reach the frontend server on port ${PORT}.`);
    console.error('start it with "node frontend/serve.js" and try again.');
    process.exit(1);
  }
  return child;
}

const PAGE_URL = `${ORIGIN}/` + path.basename(PAGE);

// Desktop and a small phone: the form has to stay one readable column at both.
const SIZES = [[1262, 900], [390, 844]];

// Each size is rendered inside an iframe of exactly that width, because Chrome
// clamps a real window to 504px minimum and --dump-dom has no device-emulation
// switch. The iframe is a genuine viewport as far as CSS is concerned.
const frameFor = (w, h) => `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#fff">
<iframe src="${PAGE_URL}" style="width:${w}px;height:${h}px;border:0;display:block"></iframe>
<pre id="verify-result"></pre>
<script>
addEventListener('message', (e) => {
  document.getElementById('verify-result').textContent = JSON.stringify(e.data, null, 1);
});
</script>`;

const results = [];
const server = await ensureServer();
try {
  for (const [w, h] of SIZES) {
    fs.writeFileSync(FRAME, frameFor(w, h));
    const dom = chromeDump([w + 60, h + 120]);
    const m = dom.match(/<pre id="verify-result">([\s\S]*?)<\/pre>/);
    if (!m || !m[1].trim()) {
      console.error(`no result at ${w}x${h} — the page did not report back.`);
      if (/login\.html/.test(dom)) console.error('  it redirected to the login page');
      process.exit(1);
    }
    results.push([w, JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))]);
  }
} finally {
  try { fs.unlinkSync(PAGE); } catch {}
  try { fs.unlinkSync(FRAME); } catch {}
  if (server) server.kill();
}

function chromeDump([w, h]) {
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--window-size=${w},${h}`,
    // The dashboard pulls ECharts and three.js from a CDN before its own inline
    // script runs. With no network those fetches never settle and Chrome dumps
    // the DOM before the app has booted, so send them somewhere dead immediately.
    '--host-resolver-rules=MAP cdnjs.cloudflare.com 127.0.0.1:1',
    '--virtual-time-budget=9000',
    '--user-data-dir=' + path.join(os.tmpdir(), 'siq-chrome-profile'),
    '--dump-dom', 'http://127.0.0.1:3000/' + path.basename(FRAME),
  ];
  try {
    return execFileSync(CHROME, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    const out = (e.stdout || '').toString();
    if (!out) { console.error('chrome failed:', e.message); process.exit(1); }
    return out;
  }
}

let bad = 0;
for (const [width, r] of results) {
  // If the page never booted there is nothing to measure; say so plainly instead
  // of throwing on a missing field.
  if (r.steps && r.steps.length) {
    console.error(`the page did not reach the modal at ${width}px:`);
    for (const s of r.steps) console.error('  ' + s);
    if (r.errors && r.errors.length) console.error('  js errors: ' + r.errors.join('; '));
    process.exit(1);
  }

  const say = (ok, msg) => { if (!ok) bad++; console.log((ok ? '  ok  ' : '  FAIL ') + msg); };
  const vp = r.viewport || { w: 0, h: 0 };
  const phone = width <= 500;
  console.log(`Add Stock in headless Chrome — ${phone ? 'phone' : 'desktop'} (viewport ${vp.w}x${vp.h})`);
  console.log(`  modal width: ${r.modalWidth}px`);
  console.log('');
  say(r.errors.length === 0, 'no javascript errors on the page' + (r.errors.length ? ': ' + r.errors.join('; ') : ''));
  say(r.fieldsOnce, 'each of the 7 fields is present exactly once');
  say(r.labels && r.labels.length === 7, `exactly 7 labels (found ${(r.labels || []).length}: ${(r.labels || []).join(' | ')})`);
  say(!r.dupLabels || r.dupLabels.length === 0, 'no duplicated labels' + (r.dupLabels && r.dupLabels.length ? ': ' + r.dupLabels.join(', ') : ''));
  say(!r.dupInputs || r.dupInputs.length === 0, 'no duplicated inputs' + (r.dupInputs && r.dupInputs.length ? ': ' + r.dupInputs.join(', ') : ''));
  say(r.addGoCount === 1, 'the Add Stock button appears exactly once');
  say(r.buttons && r.buttons.filter(b => /add stock/i.test(b)).length === 1,
    'only one Add Stock button: ' + JSON.stringify(r.buttons));
  say(r.labelsAboveInputs, 'every label sits above its own input');
  say(r.singleColumn, 'all fields share one left edge (single column), lefts=' + JSON.stringify(r.lefts));
  say(!r.overlaps || r.overlaps.length === 0, 'no field overlaps the one above it' + (r.overlaps && r.overlaps.length ? ': ' + r.overlaps.join(', ') : ''));
  say(r.spaced, `every field is grouped with its own label (label gap >= 4px, min ${r.minGap}px; clear of the field above)`
    + (r.badGrouping && r.badGrouping.length ? ': ' + r.badGrouping.join(', ') : ''));
  say(r.fitsViewport && !r.overflowing.length && !r.docScrollsSideways,
    'the form fits the screen with no sideways scrolling'
    + (r.overflowing && r.overflowing.length ? '; overflowing: ' + r.overflowing.join(', ') : '')
    + (r.docScrollsSideways ? '; the page scrolls sideways' : ''));
  say(JSON.stringify(r.renderOrder) === JSON.stringify(EXPECT.map(([l]) => l + (l === 'Invoice No.' ? '' : ' *'))),
    'fields render in the specified order: ' + JSON.stringify(r.renderOrder));
  console.log('');
  console.log('measured geometry:');
  for (const g of r.geo || []) {
    if (g.missing) { console.log('  ' + g.label + ': MISSING'); continue; }
    console.log(`  ${g.labelText.padEnd(24)} label ends y=${String(g.labelBottom).padStart(4)}  input top y=${String(g.inputTop).padStart(4)}  gap=${String(g.gap).padStart(3)}px  left=${g.left}  width=${g.width}`);
  }
  console.log('');
}

console.log(bad ? `${bad} check(s) failed` : 'all browser checks passed');
process.exitCode = bad ? 1 : 0;

})();
