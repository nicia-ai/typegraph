---
"@nicia-ai/typegraph": patch
---

`store.transaction()` no longer reports success on PostgreSQL when the database rolled the transaction back, and no longer commits a transaction the callback ended itself.

On PostgreSQL, a statement that fails inside a transaction aborts the whole transaction, even when the callback catches the error. A callback that, say, caught the duplicate-key error from creating an edge with an existing id and then returned normally used to see `store.transaction()` resolve on node-postgres and PGlite, although the database had answered the `COMMIT` with a rollback and nothing the transaction wrote, before or after the failure, was saved. On postgres-js the transaction rejected, but with the raw driver error.

Every transaction a bundled PostgreSQL backend opens now carries a marker: right after `BEGIN`, TypeGraph sets a transaction-local setting (`SET LOCAL typegraph.transaction_marker`), and right before `COMMIT` it reads the setting back on the same session. A transaction-local setting ends with the transaction that set it, so finding it proves the session is still inside the transaction TypeGraph opened. `SET` takes no snapshot, so a `REPEATABLE READ` or `SERIALIZABLE` transaction still takes its snapshot at the callback's first statement. This costs one statement after `BEGIN` and one before `COMMIT`.

- The marker is there: the transaction commits, as before. A failed statement that a savepoint rolled back is recovered and commits.
- The read is refused because the transaction is aborted: the transaction rejects with the new `TransactionRolledBackError` (code `TRANSACTION_ROLLED_BACK`). Its `cause` is the first error the database reported during the transaction; an error the driver raised without sending the statement is never the cause. `details.conflict` is `true` when any of those errors was a serialization failure or deadlock, and `retry: { attempts }` then re-runs the callback.
- The marker is gone: something other than TypeGraph ended the transaction, typically a `COMMIT`, `ROLLBACK` or `BEGIN` sent through `tx.sql`, which is not supported inside `store.transaction()`. TypeGraph does not send its `COMMIT` and rejects with the new `TransactionOutcomeUnknownError` (code `TRANSACTION_OUTCOME_UNKNOWN`). It is never retried, because re-running the callback could repeat writes a native `COMMIT` already saved.

This covers `store.transaction()`, `store.transactionWithReceipt()` and TypeGraph's own schema-write transactions, including a schema change whose data preflight caught a failed statement, whichever statement failed: a write, a read, or a statement on `tx.sql`. The check runs before a history store's capture flush, so no receipt is returned for a rejected transaction. On postgres-js, a transaction the driver rolls back because a statement failed outside its own savepoint scopes (for example after a raw `ROLLBACK TO SAVEPOINT` through `tx.sql`) also rejects with `TransactionRolledBackError` instead of the raw driver error.

The evidence a backend uses is declared as `capabilities.execution.commitOutcome`: `"session-marker"` on the bundled PostgreSQL backends, `"statement-scoped"` on SQLite, which keeps a transaction usable after a failed statement and commits as before. A backend built over a transaction handle opens savepoints, not transactions, and declares none. A custom backend that declares none behaves exactly as before. Transactions you open yourself and adopt with `store.withTransaction()` are committed by your code and are not checked.

A rejection does not always mean nothing was saved: `onOperationEnd` and `onBulkOperationEnd` run after the `COMMIT`, so an error one of them throws rejects a transaction whose writes are saved. That rejection is not a rollback.
