/**
 * CSV parsing/serialising unit tests. No database, no server.
 *   node --test tests/csv.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, parseCsvObjects, toCsv, csvField, checksum } = require('../csv');

// parseCsv returns an array of { line, cells }.
const cells = text => parseCsv(text).map(r => r.cells);

test('strips a UTF-8 BOM so the first header is not corrupted', () => {
  assert.deepStrictEqual(cells('\uFEFFsku,name\nA-1,Widget\n'), [['sku', 'name'], ['A-1', 'Widget']]);
});

test('keeps a comma inside a quoted cell', () => {
  assert.deepStrictEqual(cells('sku,name\nA-1,"Widget, large"\n'),
    [['sku', 'name'], ['A-1', 'Widget, large']]);
});

test('keeps an escaped double quote as one quote', () => {
  assert.deepStrictEqual(cells('name\n"He said ""hi"""\n'), [['name'], ['He said "hi"']]);
});

test('keeps a newline inside a quoted cell', () => {
  assert.deepStrictEqual(cells('a,b\n1,"line one\nline two"\n'),
    [['a', 'b'], ['1', 'line one\nline two']]);
});

test('handles CRLF line endings without leaving carriage returns', () => {
  assert.deepStrictEqual(cells('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('does not emit a phantom row for a trailing newline', () => {
  assert.strictEqual(parseCsv('a,b\n1,2\n').length, 2);
});

test('numbers lines from 1 so error rows match what Excel shows', () => {
  assert.deepStrictEqual(parseCsv('a\n1\n2\n3\n').map(r => r.line), [1, 2, 3, 4]);
});

test('counts physical lines correctly when a cell contains newlines', () => {
  // The quoted cell spans two lines, so the next record starts at line 4.
  assert.deepStrictEqual(parseCsv('a,b\n1,"two\nlines"\n3,4\n').map(r => r.line), [1, 2, 4]);
});

test('refuses an unclosed quote rather than guessing where the cell ends', () => {
  assert.throws(() => parseCsv('a,b\n1,"never closed\n'), /Unclosed quote/);
});

test('refuses a file whose only content is blank lines', () => {
  assert.throws(() => parseCsvObjects('   \n\n'), /empty/i);
});

test('lowercases and trims headers so Excel capitalisation still matches', () => {
  const { headers } = parseCsvObjects(' SKU , Name \nA-1,W\n');
  assert.deepStrictEqual(headers, ['sku', 'name']);
});

test('rejects a duplicate column name instead of silently dropping a value', () => {
  assert.throws(() => parseCsvObjects('sku,sku\n1,2\n'), /Duplicate column/);
});

test('rejects a header cell with no name', () => {
  assert.throws(() => parseCsvObjects(',name\n1,x\n'), /has no name/);
});

test('flags a short row and still exposes the cells that were present', () => {
  const { rows, errors } = parseCsvObjects('a,b,c\n1,2\n');
  assert.strictEqual(rows[0].data.a, '1');
  assert.strictEqual(rows[0].data.c, '');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /Expected 3 cells but found 2/);
});

test('flags a long row rather than discarding the extra cells', () => {
  const { errors } = parseCsvObjects('a,b\n1,2,3\n');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /Expected 2 cells but found 3/);
});

test('an empty required cell stays empty so validation can flag it', () => {
  const { rows } = parseCsvObjects('sku,name\nA-1,\n');
  assert.strictEqual(rows[0].data.name, '');
});

test('reports no structural errors for a well-formed file', () => {
  assert.deepStrictEqual(parseCsvObjects('sku,name\nA-1,W\nB-2,X\n').errors, []);
});

test('csvField quotes only when it has to', () => {
  assert.strictEqual(csvField('plain'), 'plain');
  assert.strictEqual(csvField('a,b'), '"a,b"');
  assert.strictEqual(csvField('say "hi"'), '"say ""hi"""');
  assert.strictEqual(csvField('two\nlines'), '"two\nlines"');
  assert.strictEqual(csvField(null), '');
});

test('toCsv round-trips a value containing a comma', () => {
  const out = toCsv(['sku', 'name'], [{ sku: 'A-1', name: 'Widget, large' }]);
  const { rows } = parseCsvObjects(out);
  assert.strictEqual(rows[0].data.name, 'Widget, large');
});

test('toCsv output can be parsed straight back', () => {
  const rows = [
    { sku: 'A-1', name: 'He said "hi", loudly' },
    { sku: 'B-2', name: 'line one\nline two' },
  ];
  const back = parseCsvObjects(toCsv(['sku', 'name'], rows));
  assert.strictEqual(back.rows[0].data.name, 'He said "hi", loudly');
  assert.strictEqual(back.rows[1].data.name, 'line one\nline two');
  assert.deepStrictEqual(back.errors, []);
});

test('checksum is stable and content-sensitive', () => {
  assert.strictEqual(checksum('abc'), checksum('abc'));
  assert.notStrictEqual(checksum('abc'), checksum('abd'));
});