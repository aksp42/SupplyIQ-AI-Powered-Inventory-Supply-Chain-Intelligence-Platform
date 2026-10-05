/**
 * forecast.js — per-product demand estimate for the dashboard.
 *
 * The AI Forecast panel needs an expected-demand range per product. Rather than
 * depend on a trained model being present, this derives the range from the
 * movement ledger, which every stock change already writes to.
 *
 * The method is deliberately plain and explainable:
 *   - Daily demand per product = units sold, averaged over the days observed.
 *   - Level      = recent mean, weighted towards the newest days, because a
 *                  product that is growing should not be forecast on a flat
 *                  average of its whole life.
 *   - Spread     = the standard deviation of daily demand, so a product that
 *                  sells in bursts gets a wider band than one that sells evenly.
 *   - Band       = level +/- z * sd * sqrt(horizon), the usual widening that
 *                  acknowledges a further-out date is less certain.
 *
 * With too little history it falls back to the inventory row's own
 * monthly_demand, and finally to a neutral default, so the panel always shows
 * an honest number instead of a hardcoded [5, 15].
 */
const { query, queryOne } = require('./mysql');

const DEFAULT_HORIZON = 7;
const NEUTRAL_LEVEL = 8;
const WEIGHTS = [1, 2, 3, 4];          // oldest -> newest

/**
 * YYYY-MM-DD for a MySQL DATE.
 *
 * mysql2 hands DATE columns back as JS Date objects, so the obvious
 * `String(value).slice(0, 10)` produces "Wed Oct 01" instead of a date, and
 * every lookup against a plain string key then misses. The pool runs at
 * +00:00, so toISOString() is the correct conversion.
 */
function isoDate(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** Small helper so this module is testable without a database. */
function summarise(dailyQuantities, horizon = DEFAULT_HORIZON) {
  const n = dailyQuantities.length;
  if (!n) return null;

  // The series is materialised with zeros for days that recorded no movement, so
  // that a product selling every other day is not read as selling every day.
  // Those zero days are real calendar days, but they are NOT evidence of demand:
  // counting them made `observedDays` report the window length rather than the
  // number of days actually observed, and it made `sufficient` true for a product
  // with a single sale in a month. Evidence and averaging are counted separately.
  const sellingDays = dailyQuantities.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);

  const mean = dailyQuantities.reduce((s, v) => s + v, 0) / n;

  // Recency weighting over the last few observed days.
  const recent = dailyQuantities.slice(-WEIGHTS.length);
  let weighted = 0;
  let weightTotal = 0;
  recent.forEach((v, i) => {
    const w = WEIGHTS[i];
    weighted += v * w;
    weightTotal += w;
  });
  const weightedMean = weighted / weightTotal;
  const level = n >= WEIGHTS.length ? (mean * 0.4 + weightedMean * 0.6) : mean;

  // Sample standard deviation; a single observation has no spread to report.
  const variance = n > 1
    ? dailyQuantities.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
    : 0;
  const sd = Math.sqrt(variance);

  const z = 1.28;                      // ~80% interval
  const band = z * sd * Math.sqrt(Math.max(1, horizon));
  const round = v => Math.max(0, Math.round(v));

  return {
    level: round(level),
    low: round(Math.max(0, level - band)),
    high: round(level + band),
    observedDays: sellingDays,
    sd: +sd.toFixed(2),
    basis: 'history',
    sufficient: sellingDays >= MIN_DAYS_FOR_FORECAST,
  };
}

// Below this many observed selling days a "forecast" is a single data point
// with an error bar drawn around it, so it is reported as history-only.
const MIN_DAYS_FOR_FORECAST = 5;

const UNITS_PER_MONTH = 30;

/** Demand range for every product in a store, keyed by product_id. */
async function demandByProduct({ organizationId, storeId, days = 30, horizon = DEFAULT_HORIZON }) {
  const bounds = await queryOne(
    `SELECT DATE_SUB(CURDATE(), INTERVAL ? DAY) AS start_at,
            DATE_SUB(CURDATE(), INTERVAL 1 DAY) AS end_at`,
    [days]);
  const startAt = new Date(`${isoDate(bounds.start_at)}T00:00:00Z`);
  const endAt = new Date(`${isoDate(bounds.end_at)}T00:00:00Z`);

  // Today is excluded on purpose: it is a partial day, so counting it as a full
  // day of demand drags every product's average down for no real reason.
  const rows = await query(
    `SELECT product_id,
            DATE(occurred_at) AS day,
            SUM(CASE WHEN direction = 'OUT' AND reason = 'sale' THEN quantity ELSE 0 END) AS sold
       FROM stock_movements
      WHERE organization_id = ? AND store_id = ?
        AND occurred_at >= ? AND occurred_at < CURDATE()
      GROUP BY product_id, DATE(occurred_at)
      ORDER BY product_id, day`,
    [organizationId, storeId, isoDate(bounds.start_at)]);

  // Only days that actually recorded a sale are kept. A movement ledger that
  // holds nothing but opening receipts would otherwise group into days whose
  // sold total is zero, and an all-zero series summarises to a level of zero —
  // which reads as "this product needs nothing" rather than "we have no sales
  // history", and so never reaches the monthly_demand fallback below.
  const soldByDay = new Map();
  for (const r of rows) {
    const pid = Number(r.product_id);
    const sold = Number(r.sold) || 0;
    if (sold <= 0) continue;
    if (!soldByDay.has(pid)) soldByDay.set(pid, new Map());
    const day = isoDate(r.day);
    soldByDay.get(pid).set(day, (soldByDay.get(pid).get(day) || 0) + sold);
  }

  // Pull monthly_demand alongside so products with no sales history at all still
  // get a defensible range rather than being left on the neutral default.
  const demandRows = await query(
    `SELECT product_id, monthly_demand FROM inventory
      WHERE organization_id = ? AND store_id = ?`,
    [organizationId, storeId]);

  const out = new Map();
  for (const r of demandRows) {
    const pid = Number(r.product_id);
    const perDay = soldByDay.get(pid);
    let estimate = null;

    if (perDay && perDay.size) {
      // Materialise the days that had no movement as well. Grouping by day only
      // returns days that sold something, and averaging just those would treat a
      // product that sells one unit every other day as selling one a day. The
      // series starts at the product's own first recorded sale: before a product
      // existed, silence is not evidence of zero demand.
      const firstDay = [...perDay.keys()].sort()[0];
      const firstSale = new Date(`${firstDay}T00:00:00Z`);
      const from = firstSale > startAt ? firstSale : startAt;
      const series = [];
      for (let t = from.getTime(); t <= endAt.getTime(); t += 86400000) {
        series.push(perDay.get(new Date(t).toISOString().slice(0, 10)) || 0);
      }
      estimate = series.length ? summarise(series, horizon) : null;
      // A real series can still be too short to forecast. It is returned with its
      // statistics so the panel can show the history, but flagged and explained
      // rather than presented as a prediction.
      if (estimate && !estimate.sufficient) {
        estimate.note = `Only ${estimate.observedDays} selling day${estimate.observedDays === 1 ? '' : 's'} `
          + 'recorded — not enough history for a forecast yet. This figure is what was sold, not a prediction.';
      }
    }

    if (!estimate) {
      const monthly = Number(r.monthly_demand) || 0;
      if (monthly > 0) {
        estimate = { level: Math.max(1, Math.round(monthly / UNITS_PER_MONTH)), low: 0,
            high: Math.max(1, Math.round(monthly / UNITS_PER_MONTH)), observedDays: 0, sd: 0,
            basis: 'monthly_demand', sufficient: false,
            // Stated plainly: this is the store's own monthly figure divided by
            // 30, not a learned pattern, and one observation cannot make one.
            note: 'No sales history yet. This uses the monthly demand you set for this product.' };
      } else {
        // Previously a hardcoded 8 with a band of 0-16, which rendered as a
        // confident-looking prediction for a product that had never sold. With no
        // history and no stated monthly demand there is nothing to forecast
        // from, and the caller is better served by saying so.
        estimate = { level: null, low: null, high: null, observedDays: 0, sd: 0,
            basis: 'none', sufficient: false,
            note: 'Not enough sales history to forecast this product yet.' };
      }
    }

    // Monthly run rate, so callers that rank "top sellers" have something real to
    // rank on instead of a column that is zero for anything not hand-entered.
    const monthlyDemandEst = estimate.level === null ? 0 : Math.round(estimate.level * UNITS_PER_MONTH);
    out.set(pid, { ...estimate, monthlyDemandEst });
  }
  return out;
}

/**
 * Real daily history for one product, for the chart's "Actual" line.
 *
 * The dashboard used to synthesise six days of history from a sine wave so the
 * chart always had something to draw. That is a decorative number on a screen
 * labelled as demand history: it moves when the page is reloaded and it has no
 * relationship to what was sold. Everything returned here is read from the
 * movement ledger.
 *
 * Days with no movement are returned explicitly as zero from the product's own
 * first movement onwards, so a product that sells intermittently is not drawn as
 * if it sold on the days it did not. Before the product existed there is no row:
 * silence then is not evidence of zero demand.
 */
async function historyForProduct({ organizationId, storeId, sku, days = 30 }) {
  const product = await queryOne(
    'SELECT id, sku, name FROM products WHERE organization_id = ? AND sku = ?',
    [organizationId, sku]);
  if (!product) return { sku, name: null, points: [], observedDays: 0, sufficient: false };

  const rows = await query(
    `SELECT DATE(occurred_at) AS day,
            SUM(CASE WHEN direction = 'OUT' AND reason = 'sale' THEN quantity ELSE 0 END) AS sold
       FROM stock_movements
      WHERE organization_id = ? AND store_id = ? AND product_id = ?
        AND occurred_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(occurred_at)
      ORDER BY day`,
    [organizationId, storeId, product.id, days]);

  const soldByDay = new Map();
  for (const r of rows) {
    const sold = Number(r.sold) || 0;
    if (sold > 0) soldByDay.set(isoDate(r.day), sold);
  }

  // Today is left out: it is a partial day and would read as a collapse in sales.
  const endAt = new Date(`${isoDate(await today())}T00:00:00Z`);
  const startAt = new Date(endAt.getTime() - days * 86400000);

  const points = [];
  for (let t = startAt.getTime(); t <= endAt.getTime() - 86400000; t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    points.push({ date: day, sold: soldByDay.get(day) || 0 });
  }

  return {
    sku: product.sku,
    name: product.name,
    points,
    observedDays: soldByDay.size,
    // A single sale cannot describe a pattern. Stating that is more useful than
    // drawing a band around one observation.
    sufficient: soldByDay.size >= 3,
  };
}

async function today() {
  const row = await queryOne('SELECT CURDATE() AS d');
  return row.d;
}

module.exports = { demandByProduct, summarise, historyForProduct, DEFAULT_HORIZON };