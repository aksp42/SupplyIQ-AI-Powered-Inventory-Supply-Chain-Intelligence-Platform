# Import & Onboarding Contract

One pipeline serves every bulk entry into SupplyIQ. This is the contract between
the uploader, the validator, the commit, and the stock ledger — and the rules a
contributor has to keep when touching it.

## The flow

```
upload ──▶ validate ──▶ review ──▶ commit ──▶ ledger
   │           │            │          │
   └─ 413 ─────┴─ 400 ──────┴─ 409 ────┴─ atomic
```

- **validate** never writes business data. It creates an `import_jobs` row and
  per-row `import_row_errors`, and returns counts.
- **commit** is the only step that writes, and it is atomic.
- The job moves `validated → committed` or `validated → failed`, never both, and
  never twice.

## Error semantics

| Status | Meaning |
|---|---|
| 400 | the body is not a usable file at all (unparseable, unknown type) |
| 413 | the file exceeds `MAX_IMPORT_BYTES` (12 MB default) |
| 409 | the job was already committed |

A **partly good file may still be committed.** Valid rows are applied and the
rejected ones are reported individually with line number, value and reason. Bad
rows are skipped, never silently dropped.

A file with **nothing valid offers no commit button**. There is no point
letting someone commit an empty import.

If a commit fails part-way, every row rolls back and the job is marked `failed`.
There is no partial-commit state to reconcile afterwards.

## Why validate and commit are separate

A shopkeeper uploading 400 rows needs to see what will happen before it happens.
Previewing the consequences of an import — before writing any of them — is the
entire point of the two-step design.

## The SKU collision that motivated this

The ledger template once shipped six SKUs that already existed in the database
under *different* product names. Importing it silently renamed live products and
left the inventory projection out of sync with them.

That is why new workspaces are created **empty** rather than pre-seeded, and why
`products` import resolves by SKU: the SKU is the identity, the name is a label.
See `login-auth.md` for the signup side of this.

## Adding an import type

1. Add the type to the type registry so `GET /api/imports/types` advertises it.
2. Write a validator that returns per-row errors with a usable message.
3. Make the commit path write through `stock.postMovement()` — never a direct
   `INSERT` into `inventory`.
4. Add the template CSV under `backend/csv/templates/`.
5. Add tests to `tests/csv.test.js`: a good file, a partly good file, and an
   entirely bad file.

Step 5 is not optional. The three cases are what prove the file is validated,
the rows are reported, and the bad rows are skipped rather than dropped.

## Verification

```bash
npm run test:csv     # all six types, validate / commit / rollback
npm run test:all     # csv plus api, ledger and the dashboard suites
```
