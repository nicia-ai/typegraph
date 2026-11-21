---
"@nicia-ai/typegraph": patch
---

`store.transaction()` no longer reports success on PostgreSQL when the database rolled the transaction back.

On PostgreSQL, a statement that fails inside a transaction aborts the whole transaction, even when the callback catches the error. A callback that, say, caught the duplicate-key error from creating an edge with an existing id and then returned normally used to see `store.transaction()` resolve on node-postgres and PGlite, although the database had answered the `COMMIT` with a rollback and nothing the transaction wrote, before or after the failure, was saved. On postgres-js the transaction rejected, but with the raw driver error.

Such a transaction now rejects with the new `TransactionRolledBackError` (code `TRANSACTION_ROLLED_BACK`), whose `cause` is the engine error that aborted it. This covers `store.transaction()`, `store.transactionWithReceipt()` and TypeGraph's own schema-write transactions, whichever statement failed: a write, a read, or a statement on the native `tx.sql` handle. The check runs before a history store's capture flush, so no receipt is returned for a rolled-back transaction. A caught serialization failure or deadlock is still retried under `retry: { attempts }`. A transaction whose failed statement was rolled back by a savepoint is healthy and still commits, and a transaction with no failed statement pays nothing for the check.

Nothing changes on SQLite, which keeps a transaction usable after a failed statement and commits it. Transactions you open yourself and adopt with `store.withTransaction()` are committed by your code and are not checked.
