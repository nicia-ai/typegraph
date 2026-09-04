---
"@nicia-ai/typegraph": minor
---

`GraphBackend` and `TransactionBackend` gain an optional `catalog` member (`BackendCatalogProbes`):
`tableExists`, `tablesExist`, `indexStates`, `dropInvalidIndex`, `columnTypes`, and an
`indexBehavior` bag (`concurrentBuilds`, `hasInvalidIndexState`, `supportsGinFamily`). It is the
one physical-schema introspection surface a store path consults directly instead of compiling a
portable query, and four call sites across three modules require it: `store.materializeIndexes()`
and `store.materializeSystemIndexes()` refuse outright without it, and the recorded-time schema
check and the recorded-time migration's column read likewise need it. `EngineProvisioning` gains a
matching optional `catalog` field; a profile that builds one populates the backend's member, and a
profile that omits it produces a backend with no `catalog` — those four call sites then refuse
with a `ConfigurationError` naming `catalog` instead of reaching engine-specific SQL with nothing
to spell it. `createPostgresBackend` and `createSqliteBackend` both supply `catalog`, each
transaction reading its own session's uncommitted state rather than the root connection's.

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

**Author-facing:** `CommonOperationStrategy` no longer carries `dynamicEdgeConvergence`. That field
was required, so every external `SqlEngineProfile.strategy` literal now fails to typecheck; delete
it from the literal. The flag it carried — whether a convergent edge create's non-durable match may
inspect JSON match fields — moved onto `OperationFusionHooks.dynamicEdgeConvergence`, which the
bundled dialect factories pass to `buildCommonOperationOptions`. Neither `OperationFusionHooks` nor
`buildCommonOperationOptions` is exported from any entrypoint (nothing under
`src/backend/drizzle/engine/` re-exports them), so a custom profile has no field to set; it
implements whatever convergent-match behavior it wants in its own `buildOperations`.
