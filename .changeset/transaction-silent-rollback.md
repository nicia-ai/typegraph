---
"@nicia-ai/typegraph": patch
---

`store.transaction()` no longer reports success on PostgreSQL when the database rolled the transaction back.

On PostgreSQL, a statement that fails inside a transaction aborts the whole transaction, even when the callback catches the error. A callback that, say, caught the duplicate-key error from creating an edge with an existing id and then returned normally used to see `store.transaction()` resolve on node-postgres and PGlite, although the database had answered the `COMMIT` with a rollback and nothing the transaction wrote, before or after the failure, was saved. On postgres-js the transaction rejected, but with the raw driver error.

Such a transaction now rejects with the new `TransactionRolledBackError` (code `TRANSACTION_ROLLED_BACK`), whose `cause` is the first engine error, the one that aborted it (a later failure, such as a syntax error PostgreSQL reports before it checks for an aborted transaction, does not replace it). This covers `store.transaction()`, `store.transactionWithReceipt()` and TypeGraph's own schema-write transactions, including a schema change whose data preflight caught a failed statement, whichever statement failed: a write, a read, or a statement on the native `tx.sql` handle. A callback that catches a failure and then issues `ROLLBACK` through `tx.sql` also rejects. The check runs before a history store's capture flush, so no receipt is returned for a rolled-back transaction. A caught serialization failure or deadlock is still retried under `retry: { attempts }`. A transaction whose failed statement was rolled back by a savepoint is healthy and still commits, and a transaction with no failed statement pays nothing for the check.

Nothing changes on SQLite, which keeps a transaction usable after a failed statement and commits it. Transactions you open yourself and adopt with `store.withTransaction()` are committed by your code and are not checked.

A rejection does not always mean nothing was saved: `onOperationEnd` and `onBulkOperationEnd` run after the `COMMIT`, so an error one of them throws rejects a transaction whose writes are saved. Ending the transaction yourself through `tx.sql` with no failed statement before it, or opening a new one there in its place, is not detected.
