# AI Forecasting

Demand forecasting, forecast confidence, replenishment recommendations and the
risk register — the data-science side of SupplyIQ.

This complements `../ARCHITECTURE.md`, which lists the eight forecasting and
replenishment tables. This document covers how a forecast is produced and, more
importantly, when to distrust it.

## Two layers, one contract

| Layer | Lives in | Role |
|---|---|---|
| Statistical baseline | `backend/forecast.js` (Node) | always available, no model training |
| ML service | `backend/ml/` (Python) | trained models, backtesting, richer features |

Both read the same demand history and must satisfy the same contract: **a
forecast that is not enough to act on must say so, rather than returning a number
that looks confident.**

## Demand history

```
GET /api/forecast/history?sku=<sku>&days=<n>
```

`historyForProduct()` returns the observed daily demand series for one SKU.

The series is materialised with **zeros for days that recorded no movement**, so a
product that sells every other day is not read as selling every day.

Those zero days are real calendar days but they are **not evidence of demand**.
`summarise()` therefore counts evidence and averaging separately:

- `sellingDays` — days with a non-zero quantity
- `n` — calendar days in the window

Conflating them was a real bug: it made `observedDays` report the window length
instead of the number of days actually observed, and it made `sufficient` return
true for a product with a single sale in a month. Evidence and averaging are now
counted independently.

## Forecast

`summarise(dailyQuantities, horizon)` blends a whole-window mean with a
recency-weighted mean:

```
level = 0.4 * mean + 0.6 * weightedMean     (when there are enough recent days)
level = mean                               (otherwise)
```

The recency weighting dominates deliberately: a shop's current trading pattern
matters more than its average over a window that includes a different season.

Spread is the sample standard deviation, and a single observation reports no
spread at all — there is nothing to be uncertain about when you have one data
point, and pretending otherwise produces a confidence band that is a fiction.

## Confidence and sufficiency

The baseline reports a `sufficient` flag alongside the numbers. It is false when
there is not enough observed history to support a forecast.

This is the part to keep honest. A forecast returned without a sufficiency signal
is indistinguishable from a guess, and the UI cannot tell the shopkeeper which
one they are looking at.

## Sufficiency thresholds

| Variable | Default | Meaning |
|---|---|---|
| `MIN_HISTORY_DAYS` | 14 | observed days needed before forecasting |
| `MIN_OBS_PER_PRODUCT` | 14 | observations needed per product |
| `SEASONAL_PERIOD` | 7 | weekly seasonality |
| `FORECAST_HORIZON_DAYS` | 30 | how far ahead |
| `RETRAIN_FREQUENCY_DAYS` | 7 | retraining cadence |
| `VALIDATION_DAYS` | 30 | backtest window |

## The ML service

```
backend/ml/ml/
├── config.py              settings from env; DB_PASSWORD has no default
├── database.py            reads the same MySQL schema as the backend
├── features/
│   ├── calendar.py        calendar features
│   ├── sales_features.py  sales history features
│   └── inventory_features.py  stock position features
├── models/baseline.py     baseline model
├── pipelines/forecast_pipeline.py
└── evaluation/
    ├── backtest.py        walk-forward backtesting
    └── metrics.py         error metrics
```

`config.py` takes `DB_PASSWORD` from the environment **with no default**, so a
missing value fails loudly instead of silently connecting with something
guessable. This is deliberate and is worth preserving.

## Backtesting

A forecast model that has never been scored against history it did not see is an
opinion, not a forecast. `evaluation/backtest.py` runs walk-forward validation and
`evaluation/metrics.py` scores it.

Any model change needs a backtest result attached. A model that improves the
in-sample fit and does not improve the walk-forward score has been fitted to
noise.

## Permissions

Forecasting reads stock and sales data, so it sits behind the same RBAC layer as
everything else:

- `forecast.view` — see demand forecasts
- `forecast.run` — trigger a forecast run
- `risk.view` / `risk.resolve` — read and acknowledge the risk register
- `replenishment.view` / `replenishment.approve` — read and act on reorder
  recommendations
- `settings.ai` — configure AI and forecasting behaviour

A forecast must never be able to read across tenants. Every query is scoped by
`organizationId` **and** `storeId`, and the store is validated against the token
by `requireStore`.

## Turning a forecast into a recommendation

A prediction becomes an action only after passing through stock position. The
chain is:

```
forecast → days of cover → reorder quantity → purchase order → delivery → stock
```

The dashboard shows the recommendation; a human approves it (`po.approve`,
`replenishment.approve`). Nothing is ordered automatically. That separation is the
point — an incorrect forecast must never become an automatic purchase order.

## Verifying this area

```bash
# ML service, if the Python environment is set up
cd backend/ml && python -m pytest ml/tests -q

# the endpoint contract, through the Node suite
npm run test:api
npm run test:full
```

`backend/ml/ml/tests/` covers features, models, the database layer, the API
surface and the backtester.

## Reviewer notes

- Do not make `sufficient` disappear. It is the difference between a forecast and
  a guess, and the UI depends on it.
- Do not count zero-movement days as observed demand. That was a bug once.
- Keep evidence and averaging counted separately in any new statistic.
- A model change without a walk-forward backtest number is not reviewable.
