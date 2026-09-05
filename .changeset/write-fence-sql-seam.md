---
"@nicia-ai/typegraph": minor
---

`GraphBackend` gains an optional `fenceSql` member: the lock spelling a backend supplies
alongside `capabilities.pessimisticLocks`, as `FenceSql` — three builders,
`advisoryLockExpression`, `isolationFactExpression`, and `lockTables`. `resolveWriteFencePlan`'s
`lock` arm carries `sql: FenceStatements`: those three plus the standalone `advisoryLock`,
`advisoryLockWithIsolation`, and `isolationFact` statements, which `resolveFenceStatements`
derives from the two expressions so the portable lock sites and the fused recorded-write fence
always spell the same key. Every write-fence lock site consumes `fence.sql.<builder>(...)`
instead of hand-writing PostgreSQL lock syntax inline.

The bundled PostgreSQL spelling is exported as `postgresFenceSql` from
`@nicia-ai/typegraph/adapters/drizzle/postgres`. `createPostgresBackend` supplies it
automatically; `createSqliteBackend` supplies no `fenceSql` since its fence is
`engine-serialized` and takes no lock. A backend that declares
`capabilities.pessimisticLocks.advisoryLocks: true` but supplies no `fenceSql` is now refused at
construction with a typed `ConfigurationError` (`WRITE_FENCE_SQL_UNAVAILABLE`) naming the member
to supply, rather than reaching a lock site with nothing to spell the statement.

For both bundled backends the locks taken, their order, and their modes are unchanged, and
the PostgreSQL statement text is equivalent: two advisory-lock sites now bind the lock
namespace as a parameter instead of an inline string literal (`hashtext` hashes the value
either way), and insignificant whitespace in three statements changed with the move.

Two behavior changes reach custom `dialect: "postgres"` backends. A backend declaring
`pessimisticLocks.advisoryLocks: true` without `fenceSql` is refused at construction (above).
A backend declaring only `serializedWriters: true` and no `fenceSql` is refused when a
history-capturing transaction reads its isolation level, which previously ran a hard-coded
`current_setting('transaction_isolation')` read; supply `fenceSql` (or `postgresFenceSql`) to
restore it.
