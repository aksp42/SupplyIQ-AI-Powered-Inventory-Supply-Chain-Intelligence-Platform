/**
 * csv.js — RFC 4180 CSV parsing.
 *
 * Written rather than pulled in because the import path has two requirements a
 * naive `split(',')` cannot meet:
 *
 *   1. Quoted fields may contain commas, quotes and newlines — supplier
 *      addresses and free-text notes routinely do.
 *   2. A malformed file must produce a row number and a readable reason, because
 *      the import screen shows the user exactly which line failed and why.
 */
const crypto = require('crypto');

function parseCsv(text) {
  // Strip a UTF-8 BOM. Excel writes one, and without this the first header cell
  // becomes "﻿sku", which then fails the header match and makes a perfectly good
  // file look broken.
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0, line = 1;
  // Where the current record began. A quoted cell may span several physical
  // lines, and an error has to point at the first of them — that is the row the
  // user sees highlighted in Excel, not the row's last line.
  let rowStart = 1;

  while (i < src.length) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }  // escaped quote
        inQuotes = false; i++; continue;
      }
      if (c === '\n') line++;
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      row.push(field);
      rows.push({ line: rowStart, cells: row });
      row = []; field = ''; line++; rowStart = line; i++; continue;
    }

    field += c; i++;
  }

  if (inQuotes) throw new Error(`Unclosed quote starting near line ${line}.`);
  // A trailing newline produces one empty line; drop it rather than reporting it.
  if (field !== '' || row.length) { row.push(field); rows.push({ line: rowStart, cells: row }); }
  return rows.filter(r => r.cells.some(cell => cell.trim() !== ''));
}

/**
 * Parse into objects keyed by header name.
 *
 * Structural problems are reported rather than guessed at: a duplicate or blank
 * header makes the column ambiguous, and a row with the wrong number of cells
 * means data would be lost or invented. An import that silently drops a cell is
 * worse than one that refuses the file.
 *
 * @returns {{headers:string[], rows:Array<{line:number,data:object}>, errors:Array<{line:number,message:string}>}}
 */
function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('The file is empty.');

  const headerCells = rows[0].cells.map(h => h.trim().toLowerCase().replace(/^\ufeff/, ''));
  const body = rows.slice(1);

  const errors = [];

  const blankAt = headerCells.findIndex(h => h === '');
  if (blankAt !== -1)
    throw new Error(`Column ${blankAt + 1} of the header has no name.`);

  const seen = new Map();
  headerCells.forEach((h, i) => {
    if (seen.has(h))
      errors.push({ line: 1, message: `Column "${h}" appears twice (positions ${seen.get(h) + 1} and ${i + 1}).` });
    else seen.set(h, i);
  });
  if (errors.length) throw new Error(`Duplicate column name: ${errors[0].message}`);

  const width = headerCells.length;
  for (const r of body) {
    if (r.cells.length !== width)
      errors.push({
        line: r.line,
        message: `Expected ${width} cells but found ${r.cells.length}.`,
      });
  }

  return {
    headers: headerCells,
    errors,
    // line is the 1-based line number in the original file. Row 1 is the header,
    // so the first data row is line 2 — which is what the user sees in Excel and
    // what import_row_errors.row_no must hold for the error list to line up.
    rows: body.map(r => ({
      line: r.line,
      data: Object.fromEntries(headerCells.map((h, i) => [h, (r.cells[i] ?? '').trim()])),
    })),
  };
}

/** Wrap any value in quotes when it contains a comma, quote or newline. */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(headers.map(h => csvField(row[h])).join(','));
  return lines.join('\n') + '\n';
}

function checksum(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = { parseCsv, parseCsvObjects, toCsv, csvField, checksum };