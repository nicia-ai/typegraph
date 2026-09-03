---
"@nicia-ai/typegraph": minor
---

`GraphBackend` gains an optional `fenceSql` member: the lock-statement spelling a backend
supplies alongside `capabilities.pessimisticLocks`. `resolveWriteFencePlan`'s `lock` arm now
carries `sql: FenceSql` — a bag of `advisoryLock`, `advisoryLockWithIsolation`, `lockTables`, and
`isolationFact` builders — so every write-fence lock site consumes `fence.sql.<builder>(...)`
instead of hand-writing PostgreSQL lock syntax inline.

The bundled PostgreSQL spelling is exported as `postgresFenceSql` from
`@nicia-ai/typegraph/adapters/drizzle/postgres`. `createPostgresBackend` supplies it
automatically; `createSqliteBackend` supplies no `fenceSql` since its fence is
`engine-serialized` and takes no lock. A backend that declares
`capabilities.pessimisticLocks.advisoryLocks: true` but supplies no `fenceSql` is now refused at
construction with a typed `ConfigurationError` (`WRITE_FENCE_SQL_UNAVAILABLE`) naming the member
to supply, rather than reaching a lock site with nothing to spell the statement.

This changes no emitted SQL and no behavior for either bundled backend — the PostgreSQL
lock-statement text stays exactly what every lock site rendered before, now sourced from one
module instead of nine.
