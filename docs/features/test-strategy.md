# Test inventory

What the SupplyIQ suites actually prove, and which failure class each one exists
to catch. Run them with `npm run test:full`.

## Layers

| Script | Runner | Needs a live backend? | Checks |
|---|---|---|---|
| `npm run test:api` | `node:test` | yes (port 4000) | 28 |
| `npm run test:ledger` | `node:test` | yes | 17 |
| `npm run test:csv` | `node --test` | yes | 21 |
| `npm run test:ui` | plain node | no | 21 + 2 negative controls |
| `npm run test:browser` | headless Chrome | no (fetch stubbed) | 26 |
| `npm run test:boot` | headless Chrome | yes | 25 |
| `npm run test:all` | — | yes | api + ledger + csv + ui |
| `npm run test:full` | — | yes | everything, ~30s longer |

`test:all` is the fast inner loop. `test:full` is the one that has to be green
before a push: it is the only combination that exercises the real dashboard
against a real database.

## Why there are three dashboard suites

They look redundant. They are not — each one is blind to a failure the others
catch, and the combination of all three is what found a real blank-dashboard bug.

### `test_render.js` — the function level

Pulls individual functions out of the HTML with a regex and runs them against a
small fake DOM. Fast, no browser, no server.

**Blind spot:** it cannot see the static markup. If a card's `<section>` is
deleted from the page, `renderX()` still runs perfectly, so this suite stays green
while the dashboard has a hole in it.

### `test_addstock_browser.js` — the real browser, stubbed network

Loads the actual page in headless Chrome and measures real geometry: field
positions, label gaps, overlap, horizontal scrolling, at 1262×900 and 390×844.

**Blind spot:** it stubs `fetch` to resolve `{}`. So `loadInventory()` returns
null, the whole `if (inv)` branch is skipped, and no card ever renders from data.

### `test_dashboard_boot.js` — the real browser, real network

No stubbing anywhere. Signs into a throwaway tenant, creates a product, loads the
dashboard, and asserts on the DOM the real code path produced: every one of the 13
card containers exists **and** has content, inventory reached the page (API count
matches rendered count), the Stock Out form opens and refuses to over-deduct with
the exact message, and the hero Add Stock button opens its modal.

This is the suite that catches a syntax error, a missing container, and a render
branch that silently stops running. Both of the failures above got past the other
two suites.

## Negative controls

`test_render_regression.js` and `test_preview_regression.js` deliberately break
the dashboard file and then assert that the checks *notice*. They print
`detected: N check(s) failed against the broken file` and exit 0.

They exist because a test suite that cannot fail is worse than no suite. If one
of these ever reports `detected: 0`, the corresponding checks have gone blind and
the suite must be fixed before it is trusted again.

## Test isolation

`test_dashboard_boot.js` **never signs in as the demo user and never writes to the
demo store.** Each run provisions a throwaway tenant, uses it, and tears it down.

This matters: an earlier version seeded a `Boot Check Widget` product into
`demo-store-01`, so running the suite quietly added a fake product to the store a
developer was looking at.

Isolation is verified, not assumed. The suite reports:

- the throwaway account and store it used, and that it is not the demo store
- every row it deleted during teardown
- a count proving nothing was left behind
- a before/after fingerprint of the demo store's products, inventory, suppliers
  and movements

Teardown is best-effort only in the sense that it cannot mask a test failure: if
the tenant cannot be removed, that is reported as a **failing check**.

The backend suites (`api`, `ledger`, `csv`) do still run against the canonical
demo tenant, by design. They tag everything with a per-run `TST<id>` prefix and
delete it in `after()`, so a run is repeatable against the same database.

## Running them

```bash
# terminal 1 — the API the suites talk to
cd backend && npm start

# terminal 2
cd backend && npm run test:full
```

The dashboard boot test starts the frontend and backend itself if nothing is
listening, and kills only the processes it started. It leaves a server you
started yourself running.

## Adding a test

Put the check where the failure actually lives:

| Failure | Belongs in |
|---|---|
| a function misbehaves | `test_render.js` |
| layout, spacing, field order | `test_addstock_browser.js` |
| the page does not render, or renders empty | `test_dashboard_boot.js` |
| an endpoint's contract | `tests/api.test.js` |
| a CSV type validates or commits wrongly | `tests/csv.test.js` |
| stock ledger arithmetic | `tests/ledger.test.js` |
