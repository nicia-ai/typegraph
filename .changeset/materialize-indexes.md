---
"@nicia-ai/typegraph": minor
---

Add `store.materializeIndexes(options?)` — runs `CREATE INDEX` DDL for the indexes declared on a graph and tracks per-deployment status in a new `typegraph_index_materializations` table. Closes the runtime-extension PR series for #101.

```typescript
const [store] = await createStoreWithSchema(graph, backend);

// Materialize all declared indexes (idempotent — second call reports
// alreadyMaterialized for each).
const result = await store.materializeIndexes();

// Restrict by kind:
await store.materializeIndexes({ kinds: ["Paper", "Author"] });

// Halt on first failure (default is best-effort — failures are
// recorded per-index in the result and the loop continues):
await store.materializeIndexes({ stopOnError: true });
```

## Public API

- `Store.materializeIndexes(options?: { kinds?: readonly string[]; stopOnError?: boolean })` — async; returns `MaterializeIndexesResult`.
- `MaterializeIndexesResult.results: readonly MaterializeIndexesEntry[]` — one entry per declared index with `status: "created" | "alreadyMaterialized" | "failed"`.
- New backend primitives on `GraphBackend`: `executeDdl(sql)`, `getIndexMaterialization(indexName)`, `recordIndexMaterialization(params)`. Bundled SQLite + Postgres backends implement all three.
- `GenerateIndexDdlOptions.concurrent` — Postgres-only flag for `CREATE INDEX CONCURRENTLY`. SQLite ignores. Set automatically by `materializeIndexes`.

## Storage

- New table `typegraph_index_materializations` (PK on `index_name` because SQL index names are physical, database-global identifiers — `graph_id` is provenance, not identity). Auto-bootstrapped via `bootstrapTables` for fresh DBs and re-run inside `materializeIndexes` for legacy DBs that pre-date this slice.
- Per-row signature is the SHA-256 hash of `{ dialect, targetTableName, declaration }` under sorted-key serialization. Includes the physical target table because consumers can override `tableNames` and a declaration-only signature would falsely report "already materialized" after a table rename. Excludes execution flags (`CONCURRENTLY`, `IF NOT EXISTS`) — those are runtime modifiers, not shape.

## Concurrency + safety

- Postgres uses `CREATE INDEX CONCURRENTLY`, so live tables never take an `AccessExclusiveLock`. The DDL runs at the top-level backend (not inside `transaction()`) because CIC cannot run inside a transaction.
- Status-table writes use `INSERT ... ON CONFLICT DO UPDATE` so concurrent callers don't deadlock on the bookkeeping. Failed attempts preserve any prior successful `materialized_at` timestamp via `COALESCE(excluded.materialized_at, materialized_at)`.
- Best-effort by default: per-index failures land in the result (`status: "failed"` with the captured `Error`), the loop continues, and the failure is recorded in `last_error`.
- `IF NOT EXISTS` does not validate shape on Postgres — only that something with that name exists. Drift detection here uses TypeGraph's recorded `signature`, not PG metadata. Signature mismatch surfaces as `failed` with a `different signature` message; v1 does not auto drop+recreate.
- Failed `CONCURRENTLY` builds leave invalid indexes (`pg_index.indisvalid = false`). v1 surfaces this as a `failed` result; the operator drops the invalid index manually before retry.

## Out of scope (deferred follow-ups)

- **Vector + fulltext index unification.** PR 6 covers only relational indexes. Vector / fulltext continue to use the existing per-kind imperative APIs (`createVectorIndex`, `createFulltextIndex`); lifting them into the unified declaration channel is a future PR.
- **`evolve(extension, { eager: true })`.** Convenience flag to auto-materialize after `evolve()` deferred to its own small PR — changes `evolve()` semantics on a hot path and benefits from separate review.
- **Public status-reader API.** The returned `MaterializeIndexesResult` plus the table itself is enough for v1; consumers query the table directly if they need monitoring. Will add `Store.getIndexMaterializationStatus()` only if usage demands it.
- **Auto drop+recreate on signature drift.** v1 surfaces drift; auto-cleanup is risky enough to defer.
