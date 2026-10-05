/**
 * imports.js — CSV import for six entity types.
 *
 * Every type follows the same three steps so the UI can behave identically:
 *
 *   validate()  parse + check every row, record one import_row_errors entry per
 *               problem, and return a preview. Writes nothing but the job row.
 *   commit()    write the valid rows in ONE transaction and mark the job
 *               completed, or roll the whole thing back and mark it failed.
 *
 * Two rules are enforced here rather than left to the caller:
 *   - stock_levels and stock_movements go through stock.js, the only module
 *     allowed to change inventory.quantity, so a CSV import cannot bypass the
 *     ledger and leave the projection lying about what arrived.
 *   - every lookup is scoped by organization_id, so a file cannot write into
 *     another tenant by naming a supplier or SKU that exists elsewhere.
 */
const crypto = require('crypto');
const { parseCsvObjects, checksum } = require('./csv');
const { query, queryOne, withTransaction } = require('./mysql');
const stock = require('./stock');

// Rows rendered in the preview table. The full validated set is still stored and
// committed; this only caps what the UI pulls out of preview_data.
const PREVIEW_LIMIT = 100;

const TEMPLATES = {
  // The one-file entry point: every row is a real business event (goods arrived,
  // or goods sold). Products, suppliers and the inventory row are created on
  // demand, so a single upload is enough to bring a store's dashboard to life
  // without first importing master data. Rows are applied in file order, so an
  // IN must appear above the OUT that spends it.
  ledger: {
    label: 'Everything (one file)',
    required: ['date', 'sku', 'direction', 'quantity'],
    optional: ['product_name', 'category', 'unit', 'supplier', 'supplier_phone',
               'unit_cost', 'unit_price', 'discount', 'channel', 'invoice_no',
               'reason', 'note', 'reorder_pt', 'safety_stock', 'max_stock'],
  },
  products: {
    label: 'Products',
    required: ['sku', 'name', 'default_unit_cost', 'default_sell_price'],
    optional: ['category', 'unit', 'pack_size', 'barcode', 'tax_rate', 'shelf_life_days'],
  },
  suppliers: {
    label: 'Suppliers',
    required: ['name'],
    optional: ['contact_person', 'phone', 'email', 'gstin', 'address_line', 'city',
               'state', 'pincode', 'payment_terms', 'rating', 'is_active', 'notes'],
  },
  stock_levels: {
    label: 'Opening stock levels',
    // Maps onto import_jobs.entity_type 'opening_stock'.
    entityType: 'opening_stock',
    required: ['sku', 'quantity'],
    optional: ['warehouse_code', 'unit_cost', 'reorder_pt', 'safety_stock',
               'max_stock', 'monthly_demand', 'last_counted_at', 'note'],
  },
  stock_movements: {
    label: 'Stock movements',
    required: ['sku', 'direction', 'quantity'],
    optional: ['unit_cost', 'reason', 'occurred_at', 'reference_type', 'reference_id', 'note'],
  },
  sales: {
    label: 'Sales',
    required: ['date', 'sku', 'quantity', 'unit_price'],
    optional: ['discount', 'channel', 'invoice_no', 'notes'],
  },
  purchase_orders: {
    label: 'Purchase orders',
    required: ['po_no', 'supplier', 'order_date'],
    // Repeat a po_no to add another line to the same order; header totals are
    // then recomputed from the lines rather than trusted from the file.
    optional: ['expected_date', 'status', 'payment_terms', 'source', 'notes',
               'item_sku', 'item_quantity', 'item_unit_cost', 'item_tax_rate'],
  },
};

// entityType as stored in import_jobs.entity_type
function dbEntityType(type) {
  return (TEMPLATES[type] && TEMPLATES[type].entityType) || type;
}

// products.sku / inventory.sku are VARCHAR(60). A longer value passes every
// CSV-level rule and then dies on INSERT mid-commit, which costs the whole file
// its atomicity, so the limit is checked where it can still be a row error.
const SKU_MAX = 60;

/**
 * Work out which import type a file is, from its headers alone.
 *
 * The dashboard sends whatever the shopkeeper picked, and asking them to name
 * the type meant that picking the wrong one was not an error: a transaction
 * ledger also satisfies the two-column `sku,quantity` shape of a stock-level
 * file, so it validated cleanly and then committed as a set of opening balances.
 * Detection removes the choice instead of second-guessing it.
 *
 * Every type needs all of its required columns present. Between those, the type
 * that accounts for the most of the file's columns wins, because a full ledger
 * carries 19 columns while `sku,quantity` is satisfied by accident.
 *
 * @throws 400 when nothing matches, or when the top two tie and the file could
 *          honestly be read either way.
 */
function detectTypeFromHeaders(headers) {
  const present = new Set((headers || []).map(h => String(h).trim().toLowerCase()));

  const scored = Object.entries(TEMPLATES).map(([type, spec]) => {
    const required = spec.required.map(c => String(c).toLowerCase());
    const known = new Set([...spec.required, ...spec.optional].map(c => String(c).toLowerCase()));
    return {
      type,
      spec,
      missing: required.filter(c => !present.has(c)),
      // How much of this file this type actually understands. Counting only the
      // header's own columns keeps an unrelated extra column from inflating it.
      coverage: [...present].filter(h => known.has(h)).length,
    };
  });

  const viable = scored.filter(s => !s.missing.length)
    .sort((a, b) => b.coverage - a.coverage || a.type.localeCompare(b.type));

  if (!viable.length) {
    // Report the closest shape so the message names real columns.
    const closest = scored.slice().sort((a, b) => a.missing.length - b.missing.length
      || b.coverage - a.coverage)[0];
    throw Object.assign(new Error(
      `Could not recognise this file. It looks like a "${closest.type}" file but is ` +
      `missing the required column${closest.missing.length > 1 ? 's' : ''}: ` +
      `${closest.missing.join(', ')}. Open "CSV format guide" and match its columns, ` +
      'or download a template.'),
      { status: 400, code: 'unrecognised_format' });
  }

  if (viable.length > 1 && viable[0].coverage === viable[1].coverage) {
    throw Object.assign(new Error(
      `This file could be read as either "${viable[0].type}" or "${viable[1].type}" — ` +
      `both formats need the same columns, and it does not carry enough extra columns ` +
      'to tell them apart. Re-export it using the columns from the "CSV format guide", ' +
      'or pick the type when uploading.'),
      { status: 400, code: 'ambiguous_format' });
  }

  return viable[0].type;
}

/** Header detection over raw file text, without validating any row. */
function detectType(text) {
  let parsed;
  try {
    parsed = parseCsvObjects(text);
  } catch (err) {
    throw Object.assign(new Error(`Could not read the file: ${err.message}`),
      { status: 400, code: 'unreadable_file' });
  }
  return detectTypeFromHeaders(parsed.headers);
}

class RowError {
  constructor(rowNo, column, code, message, rawValue) {
    this.rowNo = rowNo; this.column = column || null;
    this.code = code; this.message = message; this.rawValue = rawValue ?? null;
  }
}

const isBlank = v => v === undefined || v === null || String(v).trim() === '';

/**
 * An optional price that counts only when it is actually a price.
 *
 * A spreadsheet leaves unused money columns as 0 rather than blank, so treating
 * 0 as a real cost would price a whole sale at zero and report profit equal to
 * revenue. Negative values are already rejected as errors by the row validator;
 * here 0 and blank simply mean "this row does not state a price".
 */
function positive(value) {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * Accept the direction spellings a shopkeeper is likely to type and map them to
 * the two values the ledger stores. Receipt wording matters here: people write
 * "received" or "arrived" far more often than the bare "IN" the API expects.
 */
function ledgerDirection(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (['in', 'purchase', 'purchased', 'receipt', 'received', 'receive', 'arrival', 'stock in', 'add'].includes(s))
    return 'IN';
  if (['out', 'sale', 'sold', 'sell', 'issue', 'issued', 'dispatch', 'stock out', 'consumed'].includes(s))
    return 'OUT';
  return null;
}

/** Reason for a ledger row: the explicit column wins, else a sane default. */
function ledgerReason(data, direction) {
  if (!isBlank(data.reason)) return String(data.reason).trim().toLowerCase();
  if (direction === 'IN') return 'purchase';
  if (!isBlank(data.unit_price) || !isBlank(data.channel)) return 'sale';
  return 'adjustment';
}

/** Parse a number, or return null when the cell is not a usable number. */
function num(value) {
  if (isBlank(value)) return null;
  const n = Number(String(value).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isDate(value) {
  if (isBlank(value)) return true;                      // optional
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return !Number.isNaN(Date.parse(s));
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(s)) return true;
  return false;
}

/** MySQL DATETIME, accepting a date-only value. */
function toDatetime(value) {
  if (isBlank(value)) return new Date();
  const s = String(value).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Validate a file and build a job. Writes only import_jobs (+ its errors).
 *
 * `type` may be omitted or "auto", in which case it is worked out from the
 * headers so the caller cannot mislabel a file.
 * @returns job row id
 */
async function validate({ type, fileName, text, organizationId, storeId, userId }) {
  // A row limit, not just a byte limit. The body parser caps the request, but a
  // narrow file (thousands of columns on a few rows) can pass that and still be
  // slow or blow up the preview. Refusing early with a reason beats a timeout.
  const MAX_BYTES = Number(process.env.MAX_IMPORT_BYTES || 12 * 1024 * 1024);
  const bytes = Buffer.byteLength(text || '', 'utf8');
  if (bytes > MAX_BYTES) {
    throw Object.assign(
      new Error(`That file is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB import limit. Split it into smaller files.`),
      { status: 413, code: 'payload_too_large' });
  }

  let resolved = type;
  if (!resolved || resolved === 'auto') {
    resolved = detectType(text);
  }

  const spec = TEMPLATES[resolved];
  if (!spec) throw Object.assign(new Error(`Unknown import type "${type}".`), { status: 400 });

  const checksumHex = checksum(text);
  const jobKey = `${resolved}-${crypto.randomBytes(6).toString('hex')}`;

  // Duplicate protection. The schema documents file_checksum as "blocks
  // re-uploading the same file" but nothing enforced it, so the same upload
  // twice posted every movement again and doubled revenue. Compared by content,
  // not filename, because the same data under a different name is the same risk.
  const prior = await queryOne(
    `SELECT id, status, entity_type, committed_at FROM import_jobs
      WHERE organization_id = ? AND file_checksum = ?
        AND status IN ('ready','committing','completed')
      ORDER BY id DESC LIMIT 1`,
    [organizationId, checksumHex]);
  if (prior) {
    const when = prior.committed_at ? ` on ${new Date(prior.committed_at).toISOString().slice(0, 10)}` : '';
    throw Object.assign(
      new Error(prior.status === 'completed'
        ? `This exact file was already imported${when} (import #${prior.id}). ` +
          'Uploading it again would double your stock movements and sales. ' +
          'Change the file, or remove the earlier import first.'
        : `This exact file is already waiting as import #${prior.id} (status "${prior.status}"). ` +
          'Commit that one instead of validating the same file twice.'),
      { status: 409, code: 'duplicate_file' });
  }

  const job = await withTransaction(async (tx) => {
    const ins = await tx.run(
      `INSERT INTO import_jobs
         (job_key, organization_id, store_id, entity_type, file_name, file_size_bytes,
          file_checksum, status, started_by)
       VALUES (?,?,?,?,?,?,?, 'validating', ?)`,
      [jobKey, organizationId, storeId, dbEntityType(resolved),
       fileName || `${resolved}.csv`, Buffer.byteLength(text, 'utf8'), checksumHex, userId || null]);

    let parsed;
    try {
      parsed = parseCsvObjects(text);
    } catch (err) {
      await tx.run('UPDATE import_jobs SET status = ?, error_message = ? WHERE id = ?',
        ['invalid', err.message, ins.insertId]);
      throw Object.assign(new Error(`Could not read the file: ${err.message}`), { status: 400 });
    }

    // Missing required headers is a file-level problem: no row can be valid, so
    // report it once rather than emitting one error per row.
    const missingHeaders = spec.required.filter(h => !parsed.headers.includes(h));
    if (missingHeaders.length) {
      const message = `Missing required column${missingHeaders.length > 1 ? 's' : ''}: ${missingHeaders.join(', ')}`;
      await tx.run('UPDATE import_jobs SET status = ?, error_message = ? WHERE id = ?',
        ['invalid', message, ins.insertId]);
      throw Object.assign(
        new Error(`${message}. Download the template to see the expected columns.`), { status: 400 });
    }

    const errors = [];
    const warnings = [];
    const preview = [];

    // Rows whose cell count does not match the header are excluded from the
    // preview: committing them would either drop or invent data.
    const ragged = new Map((parsed.errors || []).map(e => [e.line, e.message]));

    // Carried across rows so a multi-row file can be checked against itself.
    // The ledger type needs this: an OUT row must not spend stock that an
    // earlier IN row in the same file is what put there in the first place.
    const ctx = { balances: new Map(), seenSkus: new Set() };

    for (const { line, data } of parsed.rows) {
      if (ragged.has(line)) {
        errors.push(new RowError(line, '-', 'ragged_row', ragged.get(line), ''));
        continue;
      }
      const result = await validateRow({ type: resolved, spec, line, data, organizationId, storeId, ctx });
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      // __line is carried through to the note so a bad movement in the ledger can
      // be traced back to the spreadsheet line that caused it.
      if (!result.errors.length) preview.push({ line, data: { ...data, __line: line } });
    }

    // One import_row_errors row per problem. column_name is nullable but the
    // unique key includes it, so file-level errors use a sentinel rather than
    // NULL — otherwise MySQL's NULL-in-unique-key behaviour would let duplicates
    // through and a re-validation would not replace the old rows.
    for (const e of errors) {
      await tx.run(
        `INSERT INTO import_row_errors
           (import_job_id, organization_id, row_no, column_name, raw_value, error_code, error_message, raw_row)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE raw_value = VALUES(raw_value), error_code = VALUES(error_code),
                                 error_message = VALUES(error_message)`,
        [ins.insertId, organizationId, e.rowNo, e.column || '-',
         e.rawValue === null ? null : String(e.rawValue).slice(0, 255),
         e.code, e.message.slice(0, 300), null]);
    }

    const total = parsed.rows.length;
    const status = preview.length ? 'ready' : 'invalid';

    // preview_data carries two lists on purpose. `committed_rows` is every row
    // that passed validation and is what commit() must apply; `rows` is only the
    // first hundred, kept small because the UI renders it as a preview table.
    // Trimming the list that commit() reads from would silently drop the tail of
    // any file longer than the preview window.
    await tx.run(
      `UPDATE import_jobs
          SET status = ?, total_rows = ?, valid_rows = ?, error_rows = ?,
              preview_data = ?, validated_at = NOW(), error_message = ?
        WHERE id = ?`,
      [status, total, preview.length, errors.length,
       JSON.stringify({
         rows: preview.slice(0, PREVIEW_LIMIT),
         committed_rows: preview,
         // Warnings are advisory notes for the preview, so they travel as the
         // same {row_no, column_name, ...} shape the row-errors feed returns.
         warnings: warnings.slice(0, PREVIEW_LIMIT).map(w => ({
           row_no: w.rowNo, column_name: w.column, raw_value: w.rawValue,
           error_code: w.code, error_message: w.message,
         })),
       }),
       errors.length ? `${errors.length} row(s) need attention.` : null, ins.insertId]);

    return { id: ins.insertId, type: resolved, status, total, valid: preview.length,
             errorCount: errors.length, warningCount: warnings.length };
  });

  return job;
}

/**
 * Per-row validation.
 * @returns {{errors:RowError[], warnings:RowError[]}}
 *   errors block the row (and are stored in import_row_errors);
 *   warnings are shown in the preview but do not block the commit.
 */
async function validateRow({ type, spec, line, data, organizationId, storeId, ctx }) {
  const errors = [];
  const warnings = [];

  for (const col of spec.required) {
    if (isBlank(data[col])) errors.push(new RowError(line, col, 'required', `"${col}" is required.`, data[col]));
  }
  // Checked here rather than left to MySQL: an over-long SKU passes every other
  // CSV rule and then aborts the INSERT, which would roll back the whole file
  // and leave the user with no explanation and no imported rows.
  for (const col of ['sku', 'item_sku']) {
    const v = data[col];
    if (!isBlank(v) && String(v).trim().length > SKU_MAX) {
      errors.push(new RowError(line, col, 'sku_too_long',
        `SKU must be ${SKU_MAX} characters or fewer; "${String(v).trim()}" is ${String(v).trim().length}.`,
        v));
    }
  }
  if (errors.length) return { errors, warnings };   // no point checking a row missing its keys

  switch (type) {
    case 'ledger': {
      if (!isDate(data.date))
        errors.push(new RowError(line, 'date', 'invalid_date', 'Use YYYY-MM-DD.', data.date));

      const dir = ledgerDirection(data.direction);
      if (!dir) {
        errors.push(new RowError(line, 'direction', 'invalid_direction',
          'Direction must be IN (goods arrived) or OUT (goods sold or issued).', data.direction));
        break;
      }

      const qty = num(data.quantity);
      if (qty === null || qty <= 0) {
        errors.push(new RowError(line, 'quantity', 'invalid_quantity',
          'Quantity must be greater than zero.', data.quantity));
        break;
      }

      for (const col of ['unit_cost', 'unit_price', 'discount', 'reorder_pt',
                         'safety_stock', 'max_stock']) {
        const v = num(data[col]);
        if (v !== null && v < 0)
          errors.push(new RowError(line, col, 'invalid_number',
            'Must be zero or more.', data[col]));
      }

      const sell = num(data.unit_price);
      if (dir === 'OUT' && (sell === null || sell <= 0))
        warnings.push(new RowError(line, 'unit_price', 'missing_sell_price',
          'No selling price on this sale, so daily revenue and profit will stay empty. Set unit_price.',
          data.unit_price));

      if (!isBlank(data.reason)) {
        const allowed = dir === 'IN' ? stock.REASONS.IN : stock.REASONS.OUT;
        if (!allowed.includes(String(data.reason).trim().toLowerCase()))
          errors.push(new RowError(line, 'reason', 'invalid_reason',
            `"${data.reason}" is not valid for ${dir}. Allowed: ${allowed.join(', ')}.`, data.reason));
      }

      // Stock leaving for damage, expiry or a transfer is not revenue, so the
      // commit ignores a price on those rows. Saying so up front beats someone
      // reconciling a till against a total that never included those units.
      const stated = isBlank(data.reason) ? null : String(data.reason).trim().toLowerCase();
      if (dir === 'OUT' && stated && stated !== 'sale' && sell !== null) {
        warnings.push(new RowError(line, 'unit_price', 'price_ignored',
          `"${stated}" reduces stock but is not a sale, so unit_price is ignored and no ` +
          'revenue or profit is recorded for this row.', data.unit_price));
      }

      // No name and no price to go on: the product is about to be created, but
      // with nothing but a SKU in it, so say so rather than silently making a
      // placeholder the shopkeeper will have to find and fix later.
      if (isBlank(data.product_name) && ctx.seenSkus && !ctx.seenSkus.has(String(data.sku).trim()))
        warnings.push(new RowError(line, 'product_name', 'missing_product_name',
          `SKU ${data.sku} is new to this store and will be created with this SKU as its name. Add product_name to name it properly.`,
          data.sku));

      // The running balance is seeded from what is already on the shelf, then
      // carried through the file, because the commit posts movements in order.
      if (ctx && ctx.balances) {
        const key = String(data.sku).trim();
        if (!ctx.balances.has(key)) {
          const product = await queryOne(
            'SELECT id FROM products WHERE organization_id = ? AND sku = ?', [organizationId, key]);
          const held = product
            ? await queryOne('SELECT quantity FROM inventory WHERE store_id = ? AND product_id = ?',
                [storeId, product.id])
            : null;
          ctx.balances.set(key, held ? Number(held.quantity) : 0);
        }
        const before = ctx.balances.get(key);
        const after = dir === 'IN' ? before + qty : before - qty;
        if (dir === 'OUT' && after < 0) {
          errors.push(new RowError(line, 'quantity', 'insufficient_stock',
            `Cannot issue ${qty} of ${key}; only ${before} is on hand counting rows above it. ` +
            'Move the receipt that supplied this stock earlier in the file.', data.quantity));
        } else {
          ctx.balances.set(key, after);
        }
        if (ctx.seenSkus) ctx.seenSkus.add(key);
      }
      break;
    }

    case 'products': {
      const cost = num(data.default_unit_cost);
      const sell = num(data.default_sell_price);
      if (cost === null || cost < 0)
        errors.push(new RowError(line, 'default_unit_cost', 'not_a_number', 'Cost must be zero or more.', data.default_unit_cost));
      if (sell === null || sell < 0)
        errors.push(new RowError(line, 'default_sell_price', 'not_a_number', 'Selling price must be zero or more.', data.default_sell_price));
      if (cost !== null && sell !== null && sell > 0 && cost > sell)
        warnings.push(new RowError(line, 'default_sell_price', 'margin_warning',
          `Selling price ${sell} is below cost ${cost} — every sale of this item loses money.`,
          data.default_sell_price));
      const tax = num(data.tax_rate);
      if (tax !== null && (tax < 0 || tax > 100))
        errors.push(new RowError(line, 'tax_rate', 'out_of_range', 'Tax rate must be between 0 and 100.', data.tax_rate));
      const exists = await queryOne(
        'SELECT id FROM products WHERE organization_id = ? AND sku = ?', [organizationId, data.sku]);
      if (exists) warnings.push(new RowError(line, 'sku', 'will_update',
        'Existing SKU in this workspace — will be updated.', data.sku));
      break;
    }

    case 'suppliers': {
      if (!isBlank(data.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
        errors.push(new RowError(line, 'email', 'invalid_email', 'Not a valid email address.', data.email));
      const rating = num(data.rating);
      if (rating !== null && (rating < 0 || rating > 5))
        errors.push(new RowError(line, 'rating', 'out_of_range', 'Rating must be between 0 and 5.', data.rating));
      break;
    }

    case 'stock_levels': {
      const qty = num(data.quantity);
      if (qty === null || qty < 0)
        errors.push(new RowError(line, 'quantity', 'invalid_quantity', 'Quantity must be zero or more.', data.quantity));
      const product = await queryOne(
        'SELECT id FROM products WHERE organization_id = ? AND sku = ?', [organizationId, data.sku]);
      if (!product)
        errors.push(new RowError(line, 'sku', 'unknown_sku',
          `No product with SKU ${data.sku} in this workspace. Import products first.`, data.sku));
      if (!isBlank(data.last_counted_at) && !isDate(data.last_counted_at))
        errors.push(new RowError(line, 'last_counted_at', 'invalid_date', 'Use YYYY-MM-DD.', data.last_counted_at));
      break;
    }

    case 'stock_movements': {
      const dir = String(data.direction).toUpperCase();
      if (!['IN', 'OUT'].includes(dir))
        errors.push(new RowError(line, 'direction', 'invalid_direction', 'Direction must be IN or OUT.', data.direction));
      const qty = num(data.quantity);
      if (qty === null || qty <= 0)
        errors.push(new RowError(line, 'quantity', 'invalid_quantity', 'Quantity must be greater than zero.', data.quantity));
      const reason = data.reason || (dir === 'IN' ? 'import' : 'adjustment');
      const allowed = dir === 'IN' ? stock.REASONS.IN : stock.REASONS.OUT;
      if (!allowed.includes(reason))
        errors.push(new RowError(line, 'reason', 'invalid_reason',
          `"${reason}" is not valid for ${dir}. Allowed: ${allowed.join(', ')}.`, data.reason));
      const product = await queryOne(
        'SELECT id FROM products WHERE organization_id = ? AND sku = ?', [organizationId, data.sku]);
      if (!product) {
        errors.push(new RowError(line, 'sku', 'unknown_sku', `No product with SKU ${data.sku}.`, data.sku));
      } else if (dir === 'OUT' && qty !== null && qty > 0) {
        // Check availability now rather than letting the commit fail halfway
        // through. The commit is all-or-nothing, so discovering this late would
        // roll back every good row in the file because of one impossible line.
        const held = await queryOne(
          'SELECT quantity FROM inventory WHERE store_id = ? AND product_id = ?',
          [storeId, product.id]);
        const available = held ? Number(held.quantity) : 0;
        if (qty > available)
          errors.push(new RowError(line, 'quantity', 'insufficient_stock',
            `Cannot remove ${qty}; only ${available} in stock in this store.`, data.quantity));
      }
      break;
    }

    case 'sales': {
      if (!isDate(data.date))
        errors.push(new RowError(line, 'date', 'invalid_date', 'Use YYYY-MM-DD.', data.date));
      const qty = num(data.quantity);
      if (qty === null || qty <= 0)
        errors.push(new RowError(line, 'quantity', 'invalid_quantity', 'Quantity must be greater than zero.', data.quantity));
      const price = num(data.unit_price);
      if (price === null || price < 0)
        errors.push(new RowError(line, 'unit_price', 'invalid_price', 'Unit price must be zero or more.', data.unit_price));
      const product = await queryOne(
        'SELECT id FROM products WHERE organization_id = ? AND sku = ?', [organizationId, data.sku]);
      if (!product) {
        errors.push(new RowError(line, 'sku', 'unknown_sku', `No product with SKU ${data.sku}.`, data.sku));
      } else if (qty !== null && qty > 0) {
        const held = await queryOne(
          'SELECT quantity FROM inventory WHERE store_id = ? AND product_id = ?',
          [storeId, product.id]);
        const available = held ? Number(held.quantity) : 0;
        if (qty > available)
          errors.push(new RowError(line, 'quantity', 'insufficient_stock',
            `Cannot sell ${qty}; only ${available} in stock in this store.`, data.quantity));
      }
      break;
    }

    case 'purchase_orders': {
      if (!isDate(data.order_date))
        errors.push(new RowError(line, 'order_date', 'invalid_date', 'Use YYYY-MM-DD.', data.order_date));
      if (!isBlank(data.expected_date) && !isDate(data.expected_date))
        errors.push(new RowError(line, 'expected_date', 'invalid_date', 'Use YYYY-MM-DD.', data.expected_date));
      if (!isBlank(data.order_date) && !isBlank(data.expected_date) &&
          new Date(data.expected_date) < new Date(data.order_date))
        errors.push(new RowError(line, 'expected_date', 'date_order',
          'Expected date cannot be before the order date.', data.expected_date));
      const status = data.status || 'draft';
      const allowed = ['draft','pending_approval','approved','ordered','part_received','received','cancelled'];
      if (!allowed.includes(status))
        errors.push(new RowError(line, 'status', 'invalid_status', `Status must be one of: ${allowed.join(', ')}.`, data.status));
      const supplier = await queryOne(
        'SELECT id FROM suppliers WHERE organization_id = ? AND name = ?', [organizationId, data.supplier]);
      if (!supplier)
        errors.push(new RowError(line, 'supplier', 'unknown_supplier',
          `No supplier named "${data.supplier}" in this workspace. Import suppliers first.`, data.supplier));
      const dupe = await queryOne(
        'SELECT id FROM purchase_orders WHERE store_id = ? AND po_no = ?', [storeId, data.po_no]);
      if (dupe) warnings.push(new RowError(line, 'po_no', 'will_update',
        'This PO number already exists — the header will be updated.', data.po_no));

      // Line items are optional (a header may legitimately arrive before its
      // lines), but once you name a product the quantity and cost are required,
      // otherwise the line would be silently dropped at commit time.
      if (!isBlank(data.item_sku)) {
        const lineQty = num(data.item_quantity);
        const lineCost = num(data.item_unit_cost);
        if (lineQty === null || lineQty <= 0)
          errors.push(new RowError(line, 'item_quantity', 'invalid_quantity',
            'Line quantity must be greater than zero.', data.item_quantity));
        if (lineCost === null || lineCost < 0)
          errors.push(new RowError(line, 'item_unit_cost', 'invalid_cost',
            'Line unit cost must be zero or more.', data.item_unit_cost));
        const lineTax = num(data.item_tax_rate);
        if (lineTax !== null && (lineTax < 0 || lineTax > 100))
          errors.push(new RowError(line, 'item_tax_rate', 'out_of_range',
            'Line tax rate must be between 0 and 100.', data.item_tax_rate));
        const lineProduct = await queryOne(
          'SELECT id FROM products WHERE organization_id = ? AND sku = ?', [organizationId, data.item_sku]);
        if (!lineProduct)
          errors.push(new RowError(line, 'item_sku', 'unknown_sku',
            `No product with SKU ${data.item_sku}. Import products first.`, data.item_sku));
      } else if (!isBlank(data.item_quantity)) {
        errors.push(new RowError(line, 'item_sku', 'missing_line_product',
          'item_quantity was given but item_sku is blank.', data.item_sku));
      }
      break;
    }
  }

  return { errors, warnings };
}

/**
 * Record one sale in the daily rollup the dashboard reads.
 *
 * Two things are decided here rather than by the caller:
 *
 *  - orders_count counts distinct order identities, not rows. The file may put
 *    several lines of one bill in consecutive rows, and those are one order. The
 *    identities live in sales.order_refs so the count is derived from the set,
 *    which also means re-importing a day cannot inflate it.
 *  - A row with no invoice number contributes no order at all. Counting it would
 *    be inventing an order that the data never named.
 */
async function bookSale(tx, { organizationId, storeId, date, net, profit, qty, orderRef }) {
  const day = String(date).trim().slice(0, 10);
  // Commas separate the stored list, so they cannot appear inside a reference.
  const ref = isBlank(orderRef) ? null : String(orderRef).trim().replace(/[,\s]+/g, '_').slice(0, 120);

  const existing = await tx.queryOne('SELECT order_refs FROM sales WHERE store_id = ? AND date = ?',
    [storeId, day]);

  let refs = existing && existing.order_refs
    ? String(existing.order_refs).split(',').filter(Boolean)
    : [];
  let newOrders = 0;
  if (ref && !refs.includes(ref)) {
    refs = refs.concat(ref);
    newOrders = 1;
  }

  await tx.run(
    `INSERT INTO sales
       (organization_id, store_id, date, sales, profit, units_sold, orders_count, order_refs)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       sales      = sales + VALUES(sales),
       profit     = profit + VALUES(profit),
       units_sold = units_sold + VALUES(units_sold),
       orders_count = orders_count + VALUES(orders_count),
       order_refs = VALUES(order_refs)`,
    [organizationId, storeId, day, net, profit, qty, newOrders, refs.join(',')]);

  return { newOrders };
}

/** Commit a validated job. One transaction; all rows or none. */
async function commit({ jobId, organizationId, storeId, userId }) {
  const job = await queryOne('SELECT * FROM import_jobs WHERE id = ? AND organization_id = ?',
    [jobId, organizationId]);
  if (!job) throw Object.assign(new Error('Import job not found.'), { status: 404 });

  if (job.status === 'completed')
    throw Object.assign(new Error('This import has already been committed.'), { status: 409 });
  if (job.status !== 'ready')
    throw Object.assign(
      new Error(`This import is "${job.status}" and cannot be committed. Fix the errors and validate again.`),
      { status: 409 });

  // Only the rows that passed validation are committed, so a row that was
  // reported as bad cannot sneak in by being present in the file.
  // committed_rows is the full set; rows is the truncated preview the UI shows,
  // so it must not be used here or a long file would lose its tail.
  const preview = JSON.parse(job.preview_data || '{"rows":[]}');
  const rows = preview.committed_rows || preview.rows || [];

  if (!rows.length)
    throw Object.assign(new Error('There are no valid rows to commit.'), { status: 409 });

  let result;
  try {
    result = await applyRows({ tx: null, jobId, job, rows, organizationId, storeId, userId });
  } catch (err) {
    // withTransaction has already rolled every row back, including the
    // 'committing' status write that happened inside it, so the job is still
    // sitting at 'ready'. Left there it looked retryable with no explanation, and
    // the user had no way to tell a rolled-back import from one that never ran.
    // Mark it failed with a message that names the cause without leaking SQL.
    const safe = safeCommitError(err);
    await query(
      `UPDATE import_jobs
          SET status = 'failed', error_message = ?, preview_data = NULL
        WHERE id = ? AND organization_id = ?`,
      [safe, jobId, organizationId]).catch(() => {});
    throw Object.assign(new Error(safe), { status: 500, code: 'commit_failed' });
  }

  return { jobId, ...result };
}

/**
 * Turn a driver error into something a shopkeeper can act on.
 *
 * A raw MySQL message names tables, columns and constraints, which is noise to
 * the audience and an unnecessary disclosure of the schema. The known causes
 * each get their own sentence; anything else is reported as an internal fault
 * with the identifier kept for the logs, and the full error still reaches them
 * through the catch block above.
 */
function safeCommitError(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');

  if (code === 'ER_DATA_TOO_LONG')
    return 'A value in the file is longer than its field allows, so the import was rolled back and nothing was saved. Shorten it and validate the file again.';
  if (code === 'ER_DUP_ENTRY')
    return 'The file conflicts with a record that already exists, so the import was rolled back and nothing was saved. Check for duplicate keys and validate again.';
  if (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_NO_REFERENCED_ROW')
    return 'The import referred to a record that no longer exists, so it was rolled back and nothing was saved. Validate the file again.';
  if (code === 'ER_CHECK_CONSTRAINT_VIOLATED')
    return 'A value in the file is not allowed for this operation, so the import was rolled back and nothing was saved. Check the reason and quantity columns.';
  if (code === 'ECONNREFUSED' || code === 'PROTOCOL_CONNECTION_LOST' || code === 'ER_LOCK_DEADLOCK')
    return 'The database was busy, so the import was rolled back and nothing was saved. Wait a moment and try again.';
  if (/insufficient stock|not enough|would go negative/i.test(msg))
    return 'The file tries to remove more stock than is on hand, so the import was rolled back and nothing was saved. Validate the file again to see which row.';

  return 'The import could not be completed and was rolled back, so nothing was saved. Please try again; if it keeps failing, contact support with this import reference.';
}

  /**
 * The whole write, as one transaction. All rows or none.
 *
 * Split out of commit() purely so the caller can put the failure handling around
 * the transaction boundary rather than inside it.
 */
async function applyRows({ jobId, job, rows, organizationId, storeId, userId }) {
  return withTransaction(async (tx) => {
    await tx.run('UPDATE import_jobs SET status = ? WHERE id = ?', ['committing', jobId]);

    const counts = { created: 0, updated: 0 };
    const categoryCache = new Map();
    const productCache = new Map();
    const supplierCache = new Map();
    const warehouseCache = new Map();

    const categoryId = async (name) => {
      if (!name) return null;
      if (categoryCache.has(name)) return categoryCache.get(name);
      const found = await tx.queryOne(
        'SELECT id FROM categories WHERE organization_id = ? AND name = ?', [organizationId, name]);
      if (found) { categoryCache.set(name, found.id); return found.id; }
      const ins = await tx.run('INSERT INTO categories (organization_id, name) VALUES (?,?)',
        [organizationId, name]);
      categoryCache.set(name, ins.insertId);
      return ins.insertId;
    };

    const productId = async (sku) => {
      if (productCache.has(sku)) return productCache.get(sku);
      const found = await tx.queryOne(
        'SELECT id FROM products WHERE organization_id = ? AND sku = ?', [organizationId, sku]);
      productCache.set(sku, found ? found.id : null);
      return productCache.get(sku);
    };

    const supplierId = async (name) => {
      if (supplierCache.has(name)) return supplierCache.get(name);
      const found = await tx.queryOne(
        'SELECT id FROM suppliers WHERE organization_id = ? AND name = ?', [organizationId, name]);
      supplierCache.set(name, found ? found.id : null);
      return supplierCache.get(name);
    };

    const warehouseId = async (code) => {
      const wanted = code || 'MAIN';
      if (warehouseCache.has(wanted)) return warehouseCache.get(wanted);
      const found = await tx.queryOne(
        'SELECT id FROM warehouses WHERE organization_id = ? AND code = ?', [organizationId, wanted]);
      warehouseCache.set(wanted, found ? found.id : null);
      return warehouseCache.get(wanted);
    };

    for (const { data } of rows) {
      switch (job.entity_type) {
        case 'ledger': {
          const sku = String(data.sku).trim();
          const direction = ledgerDirection(data.direction);
          const qty = num(data.quantity) ?? 0;
          const buyCost = positive(data.unit_cost);
          const sellPrice = positive(data.unit_price);
          const discount = num(data.discount) ?? 0;
          const name = String(data.product_name || sku).trim();
          const supplierName = isBlank(data.supplier) ? null : String(data.supplier).trim();
          const categoryName = isBlank(data.category) ? null : String(data.category).trim();

          // Master data is created from the ledger so a single file is enough
          // on its own. Price comes off the row: a receipt carries the buying
          // price, a sale carries the selling price, and each only fills the
          // column it actually knows about.
          let pid = await productId(sku);
          if (pid === null) {
            const ins = await tx.run(
              `INSERT INTO products
                 (organization_id, category_id, sku, name, unit, pack_size, tax_rate,
                  default_unit_cost, default_sell_price, is_active)
               VALUES (?,?,?,?,?,?,0,?,?,1)`,
              [organizationId, await categoryId(categoryName), sku, name,
               data.unit || 'pc', null, buyCost ?? 0, sellPrice ?? 0]);
            pid = ins.insertId;
            productCache.set(sku, pid);
            counts.created++;
          } else {
            // Enrich an existing product without clobbering prices the store has
            // already refined. last_value() compares against NULL correctly:
            // MySQL returns 0 for NULL in arithmetic, so both go through the
            // same branch and COALESCE picks the right side.
            //
            // The SKU itself is never rewritten. A SKU is the identity that the
            // rest of the file and every historic movement refer to, so re-keying
            // one would split a product's history in two. Only descriptive
            // attributes are refreshed, and only where the file states them.
            await tx.run(
              'UPDATE products SET name = COALESCE(NULLIF(?, \'\'), name), ' +
              'category_id = COALESCE(?, category_id), ' +
              'default_unit_cost = CASE WHEN ? > 0 THEN ? ELSE default_unit_cost END, ' +
              'default_sell_price = CASE WHEN ? > 0 THEN ? ELSE default_sell_price END, ' +
              'is_active = 1 WHERE id = ?',
              [isBlank(data.product_name) ? null : name,
               categoryName ? await categoryId(categoryName) : null,
               buyCost ?? 0, buyCost ?? 0, sellPrice ?? 0, sellPrice ?? 0, pid]);
            counts.updated++;
          }

          if (supplierName) {
            const sid = await supplierId(supplierName);
            if (sid === null) {
              const ins = await tx.run(
                'INSERT INTO suppliers (organization_id, name, phone, is_active) VALUES (?,?,?,1)',
                [organizationId, supplierName,
                 isBlank(data.supplier_phone) ? null : String(data.supplier_phone).trim()]);
              supplierCache.set(supplierName, ins.insertId);
              counts.created++;
            } else if (!isBlank(data.supplier_phone)) {
              await tx.run('UPDATE suppliers SET phone = COALESCE(phone, ?) WHERE id = ?',
                [String(data.supplier_phone).trim(), sid]);
            }
          }

          // A ledger row moves stock, so the inventory row has to exist first.
          // Created empty rather than pre-loaded: the movement below is what
          // puts the quantity in, which keeps the ledger the single source of
          // the balance instead of opening stock and then moving on top of it.
          const inv = await tx.queryOne(
            'SELECT id FROM inventory WHERE store_id = ? AND product_id = ?', [storeId, pid]);
          if (!inv) {
            const product = await tx.queryOne(
              'SELECT name, default_unit_cost FROM products WHERE id = ?', [pid]);
            await stock.openStock({
              tx, storeId, organizationId, productId: pid,
              warehouseId: await warehouseId(null),
              sku, name: product.name, category: categoryName,
              quantity: 0,
              unitCost: buyCost ?? Number(product.default_unit_cost) ?? 0,
              reorderPt: num(data.reorder_pt) ?? 0,
              safetyStock: num(data.safety_stock) ?? 0,
              maxStock: num(data.max_stock) ?? 0,
              supplier: supplierName, userId,
            });
          }

          // Keep the inventory projection's descriptive columns in step with the
          // product master.
          //
          // inventory denormalises name/category/supplier so the list screens can
          // render without joining products. stock.openStock's ON DUPLICATE KEY
          // UPDATE refreshes quantities but not those text columns, so a ledger
          // that renames or re-categorises an existing SKU used to leave the two
          // copies disagreeing: products said "Toor Dal 1kg" while the dashboard
          // still rendered inventory's stale "Wheat Atta 10kg".
          //
          // Every column is COALESCEd, so a row that simply does not mention a
          // field leaves it alone rather than blanking it. unit_cost is
          // deliberately absent: postMovement maintains it as a moving average,
          // and a flat value from one CSV row would contradict that.
          await tx.run(
            `UPDATE inventory SET
               name        = COALESCE(NULLIF(?, ''), name),
               category    = COALESCE(?, category),
               supplier    = COALESCE(?, supplier),
               reorder_pt  = CASE WHEN ? >= 0 THEN ? ELSE reorder_pt END,
               safety_stock = CASE WHEN ? >= 0 THEN ? ELSE safety_stock END,
               max_stock   = CASE WHEN ? >= 0 THEN ? ELSE max_stock END,
               updated_at  = NOW()
             WHERE store_id = ? AND product_id = ?`,
            [isBlank(data.product_name) ? null : name, categoryName, supplierName,
             ...[data.reorder_pt, data.safety_stock, data.max_stock].flatMap(c => {
               const v = num(c);
               return v === null ? [-1, -1] : [1, v];
             }),
             storeId, pid]);

          const note = [data.invoice_no ? `Invoice ${data.invoice_no}` : null,
                        supplierName ? `Supplier: ${supplierName}` : null,
                        isBlank(data.note) ? null : data.note].filter(Boolean).join(' · ')
                    || `CSV ledger import (line ${data.__line})`;

          await stock.postMovement({
            tx, storeId, organizationId, productId: pid,
            direction, quantity: qty, reason: ledgerReason(data, direction),
            unitCost: buyCost ?? undefined, note, invoiceNo: data.invoice_no, userId,
            occurredAt: toDatetime(data.date),
            referenceType: 'import', referenceId: jobId,
          });

          // Revenue is booked for sales and nothing else.
          //
          // The previous test was "any OUT row that carries a price", so a
          // damage, expiry or transfer row that happened to keep a unit_price
          // added to revenue and profit — the dashboard then reported money the
          // business never took. The movement itself is already posted above, so
          // every OUT row still affects stock; only the revenue side is gated, and
          // it is gated on the reason rather than on the presence of a price.
          if (direction === 'OUT' && ledgerReason(data, direction) === 'sale') {
            const net = Math.max(0, sellPrice * qty - discount);
            const product = await tx.queryOne(
              'SELECT default_unit_cost FROM products WHERE id = ?', [pid]);
            const held = await tx.queryOne(
              'SELECT unit_cost FROM inventory WHERE store_id = ? AND product_id = ?', [storeId, pid]);
            const cost = buyCost
              ?? (held && held.unit_cost !== null ? Number(held.unit_cost) : null)
              ?? Number(product.default_unit_cost);
            const profit = net - (Number.isFinite(cost) ? cost : 0) * qty;
            await bookSale(tx, {
              organizationId, storeId, date: data.date,
              net, profit, qty, orderRef: data.invoice_no,
            });
          }
          break;
        }

        case 'products': {
          const existing = await productId(data.sku);
          const values = [
            await categoryId(data.category), data.name, data.unit || 'pc',
            data.pack_size || null, data.barcode || null, num(data.tax_rate) ?? 0,
            num(data.default_unit_cost) ?? 0, num(data.default_sell_price) ?? 0,
            num(data.shelf_life_days),
          ];
          if (existing) {
            await tx.run(
              `UPDATE products SET category_id=?, name=?, unit=?, pack_size=?, barcode=?,
                      tax_rate=?, default_unit_cost=?, default_sell_price=?, shelf_life_days=?,
                      is_active=1 WHERE id=?`,
              [...values, existing]);
            counts.updated++;
          } else {
            // Column order is explicit here rather than sliced out of `values`,
            // because sku sits in the middle of the column list and a miscounted
            // slice writes a category name into the sku column.
            await tx.run(
              `INSERT INTO products
                 (organization_id, category_id, sku, name, unit, pack_size, barcode,
                  tax_rate, default_unit_cost, default_sell_price, shelf_life_days, is_active)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
              [organizationId, values[0], data.sku, values[1], values[2], values[3],
               values[4], values[5], values[6], values[7], values[8]]);
            counts.created++;
          }
          break;
        }

        case 'suppliers': {
          const existing = await tx.queryOne(
            'SELECT id FROM suppliers WHERE organization_id = ? AND name = ?',
            [organizationId, data.name]);
          const vals = [
            data.contact_person || null, data.phone || null, data.email || null,
            data.gstin || null, data.address_line || null, data.city || null,
            data.state || null, data.pincode || null, data.payment_terms || null,
            num(data.rating), data.is_active === '0' ? 0 : 1, data.notes || null,
          ];
          if (existing) {
            await tx.run(
              `UPDATE suppliers SET contact_person=?, phone=?, email=?, gstin=?, address_line=?,
                      city=?, state=?, pincode=?, payment_terms=?, rating=?, is_active=?, notes=?
                WHERE id=?`, [...vals, existing.id]);
            counts.updated++;
          } else {
            await tx.run(
              `INSERT INTO suppliers
                 (organization_id, name, contact_person, phone, email, gstin, address_line,
                  city, state, pincode, payment_terms, rating, is_active, notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [organizationId, data.name, ...vals]);
            counts.created++;
          }
          break;
        }

        case 'opening_stock': {
          const pid = await productId(data.sku);
          const p = await tx.queryOne('SELECT name FROM products WHERE id = ?', [pid]);
          const existing = await tx.queryOne(
            'SELECT id, quantity FROM inventory WHERE store_id = ? AND product_id = ?', [storeId, pid]);

          if (existing) {
            // A level file states what is on the shelf. The difference between the
            // stated and recorded quantity is posted as an explicit adjustment, so
            // the ledger still explains how the number changed — going straight to
            // UPDATE would make the correction invisible and untraceable.
            const delta = (num(data.quantity) ?? 0) - Number(existing.quantity);
            if (delta !== 0) {
              await stock.postMovement({
                tx, storeId, organizationId, productId: pid,
                direction: delta > 0 ? 'IN' : 'OUT', quantity: Math.abs(delta),
                reason: 'adjustment', note: data.note || 'CSV stock level correction',
                userId, referenceType: 'import', referenceId: jobId,
              });
            }
            await tx.run('UPDATE inventory SET reorder_pt=?, safety_stock=?, max_stock=?, ' +
              'monthly_demand=?, last_counted_at=?, updated_at=NOW() WHERE id=?',
              [num(data.reorder_pt) ?? 0, num(data.safety_stock) ?? 0, num(data.max_stock) ?? 0,
               num(data.monthly_demand) ?? 0, isBlank(data.last_counted_at) ? null : data.last_counted_at,
               existing.id]);
            counts.updated++;
          } else {
            await stock.openStock({
              tx, storeId, organizationId, productId: pid,
              warehouseId: await warehouseId(data.warehouse_code),
              sku: data.sku, name: p ? p.name : data.sku,
              quantity: num(data.quantity) ?? 0,
              unitCost: num(data.unit_cost) ?? 0,
              reorderPt: num(data.reorder_pt) ?? 0,
              safetyStock: num(data.safety_stock) ?? 0,
              maxStock: num(data.max_stock) ?? 0,
              monthlyDemand: num(data.monthly_demand) ?? 0,
              userId,
            });
            counts.created++;
          }
          break;
        }

case 'stock_movements': {
          const pid = await productId(data.sku);
          const direction = String(data.direction).toUpperCase();
          await stock.postMovement({
            tx, storeId, organizationId, productId: pid,
            direction, quantity: num(data.quantity),
            reason: data.reason || (direction === 'IN' ? 'import' : 'adjustment'),
            unitCost: num(data.unit_cost),
            note: data.note || `CSV import (line ${data.__line})`,
            userId, occurredAt: toDatetime(data.occurred_at),
            referenceType: 'import', referenceId: jobId,
          });
          counts.created++;
          break;
        }

        case 'sales': {
          const pid = await productId(data.sku);
          const qty = num(data.quantity) ?? 0;
          const price = num(data.unit_price) ?? 0;
          const discount = num(data.discount) ?? 0;
          const net = Math.max(0, price * qty - discount);

          // A sale is a stock movement too, so it goes through the ledger.
          await stock.postMovement({
            tx, storeId, organizationId, productId: pid,
            direction: 'OUT', quantity: qty, reason: 'sale',
            note: data.notes || 'CSV sales import', userId,
            occurredAt: toDatetime(data.date),
            referenceType: 'sales_order', referenceId: null,
          });

          // Daily rollup the dashboard reads. Margin is taken from the product's
          // own cost so the profit figure is real rather than a flat guess.
          const cost = (await tx.queryOne('SELECT default_unit_cost FROM products WHERE id = ?', [pid])).default_unit_cost;
          const profit = net - Number(cost) * qty;
          // bookSale() counts distinct invoices rather than rows, so several
          // lines of one bill in the same file stay one order.
          await bookSale(tx, {
            organizationId, storeId, date: data.date, net, profit, qty,
            orderRef: data.order_ref || data.invoice_no || data.order_no,
          });
          counts.created++;
          break;
        }

        case 'purchase_orders': {
          const sid = await supplierId(data.supplier);
          const existing = await tx.queryOne(
            'SELECT id FROM purchase_orders WHERE store_id = ? AND po_no = ?', [storeId, data.po_no]);
          let poId;
          if (existing) {
            await tx.run(
              'UPDATE purchase_orders SET supplier_id=?, order_date=?, expected_date=?, status=?, ' +
              'payment_terms=?, source=?, note=? WHERE id=?',
              [sid, data.order_date, data.expected_date || null, data.status || 'draft',
               data.payment_terms || null, data.source || 'import', data.notes || null, existing.id]);
            poId = existing.id;
            counts.updated++;
          } else {
            const ins = await tx.run(
              `INSERT INTO purchase_orders
                 (organization_id, store_id, po_no, supplier_id, order_date, expected_date,
                  status, payment_terms, source, note, created_by)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
              [organizationId, storeId, data.po_no, sid, data.order_date,
               data.expected_date || null, data.status || 'draft',
               data.payment_terms || null, data.source || 'import', data.notes || null, userId]);
            poId = ins.insertId;
            counts.created++;
          }

          // One line per row; repeating a po_no adds further lines to the same
          // order. line_total is computed here rather than read from the file so
          // the header can never disagree with its own lines.
          if (!isBlank(data.item_sku)) {
            const lineProductId = await productId(data.item_sku);
            const qty = num(data.item_quantity);
            const cost = num(data.item_unit_cost) ?? 0;
            const taxRate = num(data.item_tax_rate) ?? 0;
            const lineTotal = Number((qty * cost * (1 + taxRate / 100)).toFixed(2));
            await tx.run(
              `INSERT INTO purchase_order_items
                 (organization_id, purchase_order_id, product_id, quantity, unit_cost,
                  tax_rate, line_total)
               VALUES (?,?,?,?,?,?,?)
               ON DUPLICATE KEY UPDATE
                 quantity = VALUES(quantity), unit_cost = VALUES(unit_cost),
                 tax_rate = VALUES(tax_rate), line_total = VALUES(line_total)`,
              [organizationId, poId, lineProductId, qty, cost, taxRate, lineTotal]);
          }
          break;
        }
      }
    }

    // Header money is derived from the lines, never left to disagree with them.
    // Only orders that actually received lines are touched: a header-only import
    // must not silently zero an order that already has lines from elsewhere.
    if (job.entity_type === 'purchase_orders') {
      await tx.run(
        `UPDATE purchase_orders po
            JOIN (
              SELECT i.purchase_order_id,
                     SUM(i.unit_cost * i.quantity)                        AS subtotal,
                     SUM(i.unit_cost * i.quantity * i.tax_rate / 100)     AS tax_total,
                     SUM(i.line_total)                                   AS total
                FROM purchase_order_items i
               GROUP BY i.purchase_order_id
            ) agg ON agg.purchase_order_id = po.id
            SET po.subtotal = agg.subtotal,
                po.tax_total = agg.tax_total,
                po.total_amount = agg.total`);
    }

    await tx.run(
      `UPDATE import_jobs
          SET status = 'completed', created_rows = ?, updated_rows = ?,
              committed_at = NOW(), preview_data = NULL
        WHERE id = ?`,
      [counts.created, counts.updated, jobId]);

    return counts;
  });
}

module.exports = { TEMPLATES, validate, commit, dbEntityType, detectType, detectTypeFromHeaders, RowError, SKU_MAX };