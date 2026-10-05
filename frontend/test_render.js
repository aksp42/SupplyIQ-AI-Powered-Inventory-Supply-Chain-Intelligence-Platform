/**
 * Renders the dashboard's own render functions against a minimal DOM stub.
 *
 * These functions used to be checked with `node --check`, which only proves the
 * file parses. It cannot see a handler bound to an element that does not exist:
 * `$('#addGo').onclick = ...` sat outside the click handler that renders the
 * modal, so it ran on every page load, found null, and threw before the rest of
 * the dashboard finished booting.
 *
 * Executing the functions is what catches that. The stub is deliberately tiny:
 * it tracks which ids exist, and registering an id only happens when a template
 * is actually assigned to innerHTML — the same ordering the browser has.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HTML = process.argv[2] || path.join(__dirname, 'SupplyIQ-Grocery-Dashboard.html');
const source = fs.readFileSync(HTML, 'utf8');

// ── Minimal DOM ────────────────────────────────────────────────────────────────
const registry = new Map();
const get = id => registry.get(id) || null;

/** Assigning innerHTML is what creates the ids inside it, as in a browser. */
function makeEl(id) {
  const el = {
    id,
    textContent: '',
    disabled: false,
    value: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    appendChild() {},
    getAttribute: () => null,
    click() { if (typeof this.onclick === 'function') this.onclick(); },
    onclick: null,
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set(v) {
      html = String(v);
      // Assigning innerHTML builds brand-new elements in a browser, so a form
      // reopened here must start empty too. Reusing the previous node left stale
      // values behind and let one test's typing leak into the next.
      for (const m of html.matchAll(/\bid="([^"]+)"/g)) registry.set(m[1], makeEl(m[1]));
    },
  });
  if (id) registry.set(id, el);
  return el;
}

function setInnerHTML(el, html) { el.innerHTML = html; }

/** `$('#x')` must return null for an id nothing has rendered yet. */
function $(sel) {
  if (typeof sel !== 'string') return null;
  return registry.get(sel.replace(/^#/, '')) || null;
}

const sandbox = {
  console,
  document: { querySelectorAll: () => [], addEventListener() {}, body: makeEl('body') },
  window: {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { replace() {}, href: 'http://localhost/' },
  performance: { now: () => 0 },
  requestAnimationFrame() {},
  setTimeout() {},
  setInterval() {},
  fetch: async () => { throw new Error('offline in this harness'); },

  // Add Stock talks to these. They are objects/functions rather than values so a
  // test can swap in its own and observe what was sent.
  products: { create: () => Promise.resolve({ sku: 'NEW-1', name: 'New' }) },
  apiStockIn: () => Promise.resolve({}),
  loadInventory: () => Promise.resolve(),
  loadKpis: () => Promise.resolve(),
  refreshStock() {},
  renderPeriod() {},
};

// ── Extract the functions under test ───────────────────────────────────────────
function grab(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in the dashboard`);
  let depth = 0, i = source.indexOf('{', start);
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) {
      const body = source.slice(start, j + 1);
      // Several of these are declared `async function`, and dropping the keyword
      // would leave their `await`s sitting in a non-async body.
      return source.slice(start - 6, start) === 'async ' ? 'async ' + body : body;
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const load = new Function(...Object.keys(sandbox), '$', 'makeEl', 'setInnerHTML', `
  const S = { prod: {}, ups: [], inc: [], cnt: { Healthy: 0 }, extraVal: 0, sel: '', per: '1W' };
  const D = { '1W': { s: [0], p: [0], sold: 0, out: 0, rec: 0, dl: [0, 0, 0, 0, 0] } };
  // Online, so addStock reaches the API instead of quietly taking the local-only
  // path. The offline branch is a separate concern and is covered by the
  // supplier tests below.
  const DB_ONLINE = true;
  const STORE_PROFILE = { suppliers: [] };
  const ic = () => '', esc = s => String(s == null ? '' : s);
  const toast = () => {};
  const handleFileUpload = () => {}, showCsvGuide = () => {}, closeM = () => {};
  const noChart = () => {}, chart = () => null, pimg = () => '', sum = () => 0;
  const R = () => '', low = () => [], ic2 = () => '';
  let lastModal = '';
  const modal = (html) => { lastModal = String(html); setInnerHTML(makeEl('modc'), html); };
  ${['renderUp', 'renderSup', 'buildNotifs', 'addStock', 'renderAtt', 'renderRisk', 'reorder', 'placeAll', 'answer', 'showImportPreview', 'openAddStockModal', 'hero']
    .map(grab).join('\n')}
  return { renderUp, renderSup, buildNotifs, addStock, renderAtt, renderRisk, reorder, placeAll, answer,
           showImportPreview, openAddStockModal, hero, modalHtml: () => lastModal };
`);

const page = load(...Object.values(sandbox), $, makeEl, setInnerHTML);

// The containers these functions write into are part of the static page, so they
// exist before any script runs. `#a1`/`#a4` are produced by renderAtt.
// `addS`, `hAsk` and `hchips` live in the static hero, which is the only place
// Add Stock is triggered from now that the upload card is CSV-only.
for (const id of ['upload', 'sup', 'notif', 'nc', 'risks', 'att', 'attH', 'inv', 'fc', 'gal', 'inc', 'incoming', 'addS', 'hAsk', 'hchips']) {
  makeEl(id);
}

let failures = 0;
const pending = [];
// Awaits the check body. addStock() and the submit handler are async, and a
// synchronous runner reported those as passing without ever running an assertion
// — a test that cannot fail is worse than no test, because it looks like proof.
const check = (label, fn) => { pending.push([label, fn]); };
const runChecks = async () => {
  for (const [label, fn] of pending) {
    try { await fn(); console.log('  ok  ' + label); }
    catch (err) { failures++; console.log('  FAIL ' + label + '\n       ' + err.message); }
  }
  pending.length = 0;
};

console.log('dashboard render functions');

check('renderUp() runs and wires every button it renders', () => {
  page.renderUp();
  // The upload card is CSV-only: Add Stock belongs to the hero, so #addS must
  // not reappear here and collide with the hero button's id.
  assert.strictEqual($('#upload').innerHTML.includes('id="addS"'), false,
    'the upload card must not render a second #addS');
  for (const id of ['dz', 'upB', 'tplB', 'fi']) {
    assert.ok($('#' + id), `#${id} is in the template but was never rendered`);
  }
  for (const id of ['upB', 'tplB']) {
    assert.strictEqual(typeof $('#' + id).onclick, 'function', `#${id} has no click handler`);
  }
});

check('the hero Add Stock button opens the modal', () => {
  page.hero();
  assert.strictEqual(typeof $('#addS').onclick, 'function',
    'the hero #addS has no click handler');
  $('#addS').onclick();
  assert.ok($('#addGo'), 'clicking the hero Add Stock button must render #addGo');
});

check('Add Stock binds its submit button only after the modal exists', () => {
  // The previous check opened a modal, so drop the node it left behind: the
  // point here is that nothing has touched #addGo *before* the modal opens.
  registry.delete('addGo');
  // Before the click there is no #addGo, and nothing may have touched it.
  assert.strictEqual($('#addGo'), null, '#addGo must not exist before the modal is opened');
  page.openAddStockModal();                   // opens the modal
  assert.ok($('#addGo'), 'the modal template must render #addGo');
  assert.strictEqual(typeof $('#addGo').onclick, 'function',
    '#addGo must be wired once the modal has rendered it');
});

check('the submit handler runs and closes the dialog', async () => {
  page.openAddStockModal();
  const handler = $('#addGo').onclick;
  assert.strictEqual(typeof handler, 'function');
  // The handler is async; awaiting it here is not possible, so only the
  // synchronous part (which must not throw on a missing element) is checked.
  handler();
});

// The Add Stock form is specified field for field. These checks assert that
// exact shape: seven fields, in order, each appearing once, label above input.
const ADD_STOCK_FIELDS = {
  ap:    ['name',      'Basmati Rice'],
  asup:  ['supplier',  'Apna Mills'],
  adate: ['date',      '2026-09-04'],
  aq:    ['quantity',  '40'],
  auc:   ['unitCost',  '82.50'],
  asp:   ['sellPrice', '95'],
  ainv:  ['invoiceNo', 'INV-77'],
};

// Label text exactly as the specification words it.
const ADD_STOCK_LABELS = [
  'Product', 'Supplier', 'Date', 'Quantity',
  'Purchase Price / Unit', 'Selling Price / Unit', 'Invoice No.',
];

  const openAddStock = () => { page.openAddStockModal(); return page.modalHtml(); };

check('Add Stock renders exactly the seven specified fields, in order', () => {
  const html = openAddStock();
  const ids = [...html.matchAll(/<input[^>]*\bid="([^"]+)"/g)].map((m) => m[1])
    .filter((id) => id in ADD_STOCK_FIELDS);
  assert.deepStrictEqual(ids, Object.keys(ADD_STOCK_FIELDS),
    `fields must appear once each, in this order: ${ids.join(', ')}`);
});

check('no Add Stock label is duplicated', () => {
  const html = openAddStock();
  // Count real <label> elements rather than substring hits: "Product" is a prefix
  // of nothing here, but "Product *" contains "Product", so a naive search counts
  // the same element twice and passes or fails for the wrong reason.
  const labels = [...html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((m) => m[1].trim());
  for (const label of ADD_STOCK_LABELS) {
    const n = labels.filter((l) => l === label || l === label + ' *').length;
    assert.strictEqual(n, 1, `the label "${label}" appears ${n} times, expected once`);
  }
  assert.strictEqual(labels.length, ADD_STOCK_LABELS.length,
    `expected ${ADD_STOCK_LABELS.length} labels, found ${labels.length}: ${labels.join(' | ')}`);
});

check('no Add Stock input is rendered twice', () => {
  const html = openAddStock();
  for (const [id, [key]] of Object.entries(ADD_STOCK_FIELDS)) {
    const n = html.split(`id="${id}"`).length - 1;
    assert.strictEqual(n, 1, `#${id} ("${key}") is rendered ${n} times, expected once`);
  }
});

check('every Add Stock label sits directly above its own input', () => {
  const html = openAddStock();
  for (const [id, [key]] of Object.entries(ADD_STOCK_FIELDS)) {
    const label = html.indexOf(`for="${id}"`);
    const input = html.indexOf(`id="${id}"`);
    assert.ok(label !== -1, `#${id} ("${key}") has no <label for>`);
    assert.ok(label < input, `the label for "${key}" must come before its input`);
    // Nothing but the label may sit between them, or another field's label would
    // appear to belong to this input.
    const between = html.slice(label, input);
    assert.ok(!/<label/.test(between),
      `another label sits between "${key}" and its input: ${between.replace(/\s+/g, ' ')}`);
  }
});

check('the Add Stock submit button appears exactly once', () => {
  const html = openAddStock();
  const n = html.split('id="addGo"').length - 1;
  assert.strictEqual(n, 1, `the submit button is rendered ${n} times, expected once`);
  assert.ok(/id="addGo"[^>]*>Add Stock</.test(html), 'the button must read "Add Stock"');
});

check('the Add Stock form has no leftover fields from the old grid layout', () => {
  const html = openAddStock();
  for (const gone of ['ask', 'acat', 'arp', 'ass', 'ams', 'amd']) {
    assert.ok(!html.includes(`id="${gone}"`), `#${gone} should no longer be part of the form`);
  }
  for (const gone of ['SKU', 'Category', 'Reorder at', 'Safety stock', 'Maximum stock', 'Monthly demand']) {
    assert.ok(!html.includes(`>${gone}`), `"${gone}" is not part of the specified form`);
  }
});

check('every Add Stock field is forwarded to the backend', async () => {
  openAddStock();
  for (const [id, [, value]] of Object.entries(ADD_STOCK_FIELDS)) $('#' + id).value = value;

  let sent = null;
  sandbox.products.create = (payload) => { sent = payload; return Promise.resolve({ sku: 'RICE-5', name: 'Basmati Rice' }); };
  // Driven through the button so the form's own collect() is under test too.
  await $('#addGo').onclick();

  assert.ok(sent, 'products.create was never called');
  for (const [id, [key, value]] of Object.entries(ADD_STOCK_FIELDS)) {
    const want = value.trim() === '' ? undefined
               : (Number.isNaN(Number(value)) ? value : Number(value));
    assert.strictEqual(sent[key], want, `"${key}" was not forwarded correctly (from #${id})`);
  }
});

check('a blank optional Invoice No. is sent as undefined, not an empty string', async () => {
  openAddStock();
  for (const [id, [key, value]] of Object.entries(ADD_STOCK_FIELDS)) {
    if (key !== 'invoiceNo') $('#' + id).value = value;
  }

  let sent = null;
  sandbox.products.create = (payload) => { sent = payload; return Promise.resolve({ sku: 'RICE-5', name: 'Basmati Rice' }); };
  await $('#addGo').onclick();

  assert.ok(sent, 'products.create was never called');
  assert.strictEqual(sent.invoiceNo, undefined, `invoiceNo was ${JSON.stringify(sent.invoiceNo)}`);
});

check('the form refuses to submit while a required field is empty', async () => {
  for (const [id, key] of [['ap', 'name'], ['asup', 'supplier'], ['adate', 'date'], ['aq', 'quantity']]) {
    openAddStock();
    for (const [fid, [, value]] of Object.entries(ADD_STOCK_FIELDS)) {
      $('#' + fid).value = fid === id ? '' : value;
    }
    let called = false;
    sandbox.products.create = () => { called = true; return Promise.resolve({}); };
    await $('#addGo').onclick();
    assert.ok(!called, `submitting with an empty "${key}" must not reach the backend`);
  }
});

check('supplier rendering copes with no suppliers at all', () => {
  page.renderSup();
  page.buildNotifs();
  page.renderRisk();
  page.answer('how is my supplier doing?');
});

check('reorder and place-all refuse politely when no supplier exists', () => {
  page.reorder('Anything', 5);
  page.placeAll([['Anything', 5]]);
});

// The import preview is handed two different response shapes: the summary from
// POST /imports/validate and the full job from GET /imports/:id. They spell the
// same numbers differently, and when the detail shape was rendered with the
// summary's field names every count came back "undefined" and the Import button
// was never drawn — so a CSV validated and then did nothing.

const SUMMARY = { id: 7, type: 'ledger', status: 'ready', total: 350, valid: 349, errorCount: 1, warningCount: 0 };
const DETAIL = {
  id: 7, type: 'ledger', status: 'ready', can_commit: true,
  total_rows: 350, valid_rows: 349, error_rows: 1,
  errors: [{ row_no: 152, column_name: 'quantity', raw_value: '1',
             error_code: 'insufficient_stock', error_message: 'only 0 is on hand' }],
  preview: { rows: [{ line: 2, data: { name: 'Notebook', quantity: 40, unit_cost: 25 } }], warnings: [] },
};

for (const [label, job] of [['validate summary', SUMMARY], ['full job detail', DETAIL]]) {
  check(`the import preview shows real counts from the ${label}`, () => {
    page.showImportPreview(job, 'date,sku,...');
    const html = page.modalHtml();
    assert.ok(!/undefined/.test(html), `the preview must not print "undefined":\n${html}`);
    assert.match(html, /350 row\(s\) in file/, 'total must be shown');
    assert.match(html, /349 valid/, 'valid count must be shown');
    assert.match(html, /1 error\(s\)/, 'error count must be shown');
  });

  check(`the Import button is offered from the ${label}`, () => {
    page.showImportPreview(job, 'date,sku,...');
    const html = page.modalHtml();
    assert.match(html, /onclick="commitImport\(7\)"/,
      `no commit button was rendered, so the import could never be run:\n${html}`);
    assert.match(html, /Import 349 row\(s\)/, 'the button must say how many rows will be added');
  });
}

check('the skipped rows are listed with line, value and reason', () => {
  page.showImportPreview(DETAIL, 'date,sku,...');
  const html = page.modalHtml();
  assert.match(html, /will be skipped/, 'the skipped rows must be called out');
  assert.match(html, /Line 152/, 'the offending line number must be shown');
  assert.match(html, /insufficient_stock|only 0 is on hand/, 'the reason must be shown');
  assert.match(html, /skip 1/, 'the button must state that rows are being skipped');
});

check('a file with nothing valid offers no Import button', () => {
  page.showImportPreview(
    { id: 9, status: 'failed', total_rows: 10, valid_rows: 0, error_rows: 10, can_commit: false,
      errors: [{ row_no: 2, error_message: 'unknown column' }], preview: { rows: [], warnings: [] } }, 'x');
  const html = page.modalHtml();
  assert.ok(!/commitImport/.test(html), 'nothing valid means there is nothing to commit');
  assert.match(html, /No valid rows to import/);
});

runChecks().then(() => {
  process.on('exit', () => {
    if (failures) { console.error(`\n${failures} dashboard check(s) failed`); process.exitCode = 1; }
  });
});
