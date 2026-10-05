// Re-introduces the exact bug that was reported, to prove the render checks fail
// on it. Writes a broken copy and runs test_render.js against that copy.
//
// The bug: the Add Stock modal opened but its submit button was never wired, so
// clicking "Add Stock" did nothing. Add Stock now lives in exactly one place
// (openAddStockModal, bound to the hero button by hero()), so the mutation drops
// that one binding rather than editing a copy of the form.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const real = fs.readFileSync(path.join(dir, 'SupplyIQ-Grocery-Dashboard.html'), 'utf8');

const fnStart = real.indexOf('function openAddStockModal(){');
if (fnStart === -1) throw new Error('could not find openAddStockModal() to break');

const bindStart = real.indexOf("$('#addGo').onclick=async()=>{", fnStart);
if (bindStart === -1) throw new Error('could not find the #addGo binding to break');
const bindEnd = real.indexOf('\n    };', bindStart);
if (bindEnd === -1) throw new Error('could not find the end of the #addGo binding');
const close = bindEnd + '\n    };'.length;

// Drop the binding. The modal still renders, #addGo still exists — it just has
// no click handler, which is precisely what the report described.
const broken = real.slice(0, bindStart) + real.slice(close);

const out = path.join(process.env.TEMP || '.', 'dashboard-broken.html');
fs.writeFileSync(out, broken);

try {
  execFileSync(process.execPath, [path.join(dir, 'test_render.js'), out], { stdio: 'pipe' });
  console.log('NOT DETECTED — the render checks passed against the broken file');
  process.exitCode = 1;
} catch (e) {
  const msg = (e.stdout || '').toString();
  const fails = msg.match(/^\s+FAIL/gm) || [];
  console.log(`detected: ${fails.length} check(s) failed against the broken file`);
  console.log(msg.split('\n').filter(l => l.includes('FAIL')).join('\n'));
  // A broken file that fails for an unrelated reason (a harness crash, a syntax
  // error) would "detect" any mutation, which proves nothing. The checks have
  // to fail on the Add Stock assertions specifically.
  const onTarget = msg.match(/^\s+FAIL .*(Add Stock|hero|label|field|button|submit)/gim) || [];
  if (!onTarget.length) {
    console.log('failed for an unexpected reason');
    process.exitCode = 1;
  }
} finally {
  fs.unlinkSync(out);
}
