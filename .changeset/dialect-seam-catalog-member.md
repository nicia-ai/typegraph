---
"@nicia-ai/typegraph": minor
---

`GraphBackend` and `TransactionBackend` gain an optional `catalog` member (`BackendCatalogProbes`):
`tableExists`, `tablesExist`, `indexStates`, `dropInvalidIndex`, `columnTypes`, and an
`indexBehavior` bag (`concurrentBuilds`, `hasInvalidIndexState`, `supportsGinFamily`). `columnTypes`
reports each column as a `CatalogColumn`, `{ name, kind, declaredType }`; `declaredType` is
required, and every custom `columnTypes` implementation must populate it alongside the normalized
`kind` a comparison classifies against. `dropInvalidIndex` is a root-backend operation on an engine
with an invalid-index state: a `transaction()`-scoped PostgreSQL catalog refuses it with
`CATALOG_DROP_INVALID_INDEX_REQUIRES_ROOT_BACKEND`, since PostgreSQL refuses `DROP INDEX
CONCURRENTLY` inside a transaction block, while SQLite has no invalid-index state and stays a no-op
in both scopes. `catalog` is the one physical-schema introspection surface a store path consults
directly instead of compiling a portable query, and four call sites across three modules require
it: `store.materializeIndexes()` refuses only once its empty-candidate short circuit and the
status-table ensure step have already run; `store.materializeSystemIndexes()`, which has no
candidate short circuit, refuses only once that same status-table ensure step has run; the
recorded-time schema check and the recorded-time migration's column read likewise need it.
`EngineProvisioning` gains a matching optional `catalog` field; a profile that builds one populates
the backend's member, and a profile that omits it produces a backend with no `catalog` — those four
call sites then refuse with a `ConfigurationError` naming `catalog` instead of reaching
engine-specific SQL with nothing to spell it. `createPostgresBackend` and `createSqliteBackend` both
supply `catalog`, each transaction reading its own session's uncommitted state rather than the root
connection's.

`DialectCapabilities` gains `subgraphMembershipStrategy` (`"materialized-ids" | "inline-cte"`),
naming the plan-shape decision `store.subgraph()`'s reachable-node filter already made per
dialect: fetch the traversal closure once and filter against a fixed id list, or embed the
recursive closure in each fetch. This capability replaces an inline dialect comparison in
`store/subgraph.ts`; emitted SQL, round-trip counts, and the resulting query's prepared-plan
shape are unchanged for both bundled backends.

The dialect-literal ESLint ban (previously scoped to the query compiler) now also covers
`src/backend` and `src/store`, behind a named, ratcheted exemption inventory
(`DIALECT_LITERAL_EXEMPTIONS` in `eslint.config.mjs`) asserted against the tree in both
directions by `tests/dialect-literal-inventory.test.ts`. Every remaining exemption is a decision
that is not query compilation (error classification, one-shot migrations, a driver-specific
resource audit, a SQLite-only transaction write-lock flag, or the write-fence planner's own
dialect-keyed lock semantics) and carries a reason and a site count. No bundled backend's emitted
SQL, capabilities, or behavior changes.

**Behavior change:** trusted import's PostgreSQL table lock now resolves the same write-fence plan
every other lock site does, instead of unconditionally taking `LOCK TABLE ... ACCESS EXCLUSIVE`.
Trusted import now refuses up front, before any statement runs, when a custom PostgreSQL backend's
`pessimisticLocks` declaration resolves `unfenced` (absent, or present but declaring neither locks
nor serialized writers) or resolves a `lock` plan with `tableLocks: false` — this now also catches
an advisory-only declaration (`{ advisoryLocks: true, tableLocks: false }`), which previously took
the table lock anyway. A declaration resolving `engine-serialized`
(`{ advisoryLocks: false, tableLocks: false, serializedWriters: true }`) now takes no relation lock
at all, where it previously took `LOCK TABLE ... ACCESS EXCLUSIVE`: the declaration states the
engine serializes writers, so trusted import's own transaction is fence enough on its own. The
`WRITE_FENCE_SQL_UNAVAILABLE` code applies only to the narrower case of an `advisoryLocks: true`
declaration with no `fenceSql` to spell the lock; every other refusal above is
`WRITE_FENCE_UNAVAILABLE`. Declare both `advisoryLocks: true` and `tableLocks: true` — the bundled
`createPostgresBackend` default, which also supplies `fenceSql` — to restore the lock.

**Author-facing:** `CommonOperationStrategy` no longer carries `dynamicEdgeConvergence`. That field
was required, so every external `SqlEngineProfile.strategy` literal now fails to typecheck; delete
it from the literal. The flag it carried — whether a convergent edge create's non-durable match may
inspect JSON match fields — moved onto `OperationFusionHooks.dynamicEdgeConvergence`, which the
bundled dialect factories pass to `buildCommonOperationOptions`. Neither `OperationFusionHooks` nor
`buildCommonOperationOptions` is exported from any entrypoint (nothing under
`src/backend/drizzle/engine/` re-exports them), so a custom profile has no field to set; it
implements whatever convergent-match behavior it wants in its own `buildOperations`. The
`adapters/drizzle/engine` authoring entrypoint that carries `SqlEngineProfile` and
`CommonOperationStrategy` ships for the first time in this release, so this field never appeared in
a published version; the note above only affects authors building a custom profile against `main`.
