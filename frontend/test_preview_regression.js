// Confirms the import-preview checks fail against the field-name mismatch that
// was reported ("CSV upload does nothing"). Writes a copy that reads the summary
// names off the detail response and asserts the harness catches it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const real = fs.readFileSync(path.join(dir, 'SupplyIQ-Grocery-Dashboard.html'), 'utf8');

// Put back the exact expressions that caused the failure.
const broken = real
  .replace('const total      = num(job.total_rows, job.total);',
           'const total      = num(job.total);')
  .replace('const valid      = num(job.valid_rows, job.valid);',
           'const valid      = num(job.valid);')
  .replace('const errorCount = num(job.errorCount, errors.length, job.error_rows);',
           'const errorCount = num(job.errorCount);')
  .replace('const warningCount = num(job.warningCount, detail.warnings.length);',
           'const warningCount = num(job.warningCount);')
  .replace('${canCommit && valid > 0 ?', '${canCommit && job.valid > 0 ?');

if (broken === real) {
  console.error('could not build the broken copy — the expressions moved');
  process.exitCode = 1;
} else {
  const out = path.join(process.env.TEMP || '.', 'dashboard-preview-broken.html');
  fs.writeFileSync(out, broken);
  try {
    execFileSync(process.execPath, [path.join(dir, 'test_render.js'), out], { stdio: 'pipe' });
    console.log('NOT DETECTED — the preview checks passed against the broken file');
    process.exitCode = 1;
  } catch (e) {
    const msg = (e.stdout || '').toString();
    const fails = (msg.match(/FAIL/g) || []).length;
    console.log(`detected: ${fails} check(s) failed against the broken file`);
    console.log(msg.split('\n').filter(l => /FAIL|undefined|no commit button|never drawn/.test(l)).join('\n'));
    if (!fails) process.exitCode = 1;
  } finally {
    fs.unlinkSync(out);
  }
}
