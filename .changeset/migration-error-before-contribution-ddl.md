---
"@nicia-ai/typegraph": patch
---

Surface `MigrationError` before runtime-contribution DDL on a pending
breaking migration (#143).

`loadActiveSchemaWithBootstrap` ran `ensureRuntimeContributions` (fulltext
contribution DDL) **before** `ensureSchema` computed the schema diff and
threw `MigrationError`. Contribution DDL is derived from the current code
graph, so against a database still on the old schema version it was applied
to a stale table shape. On Postgres the first failing statement aborts the
surrounding transaction, and the error that escaped was the idempotent
marker-table `CREATE TABLE IF NOT EXISTS
"typegraph_contribution_materializations"` (collateral damage), not a clean
`MigrationError`. Consumers using the documented migrate-on-`MigrationError`
recovery pattern never saw a `MigrationError`, so the first request after
every breaking schema change 500'd until a concurrent boot won the migration
race.

`loadActiveSchemaWithBootstrap` no longer materializes runtime
contributions. `createStoreWithSchema` remains the single canonical
durable-marker writer and runs the materialization step **after**
`ensureSchema`, so the breaking-change gate is always reached first and a
pending breaking migration throws `MigrationError` on the first request —
making the migrate-then-retry recovery path work as documented. The pre-#129
`ensureFulltextTable` fallback is preserved at the canonical writer. No API
changes.
