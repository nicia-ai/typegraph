---
"@nicia-ai/typegraph": minor
---

Add a new entrypoint, `@nicia-ai/typegraph/adapters/drizzle/engine`, exporting
`createSqlBackend` and the `SqlEngineProfile` types. `createPostgresBackend`
and `createSqliteBackend` are now each `createSqlBackend` applied to a
profile built by `buildPostgresEngineProfile` / `buildSqliteEngineProfile`,
with no behavior change.

`createSqlBackend` refuses a profile whose resolved capabilities omit
`pessimisticLocks` with a `ConfigurationError`
(`ENGINE_PROFILE_REQUIRES_WRITE_FENCE_DECLARATION`), since every trust mark
and registration it applies assumes a resolvable write-fence decision.
