---
"@nicia-ai/typegraph": minor
---

On a Store whose backend is built over the application's own transaction, a call that overlaps another call's savepoint is now refused with `TransactionCallRefusedError` (`TRANSACTION_CALL_REFUSED`, `details.reason: "savepoint-open"`), instead of running inside that savepoint and possibly reporting success for a write its rollback then removed.

A backend built over a caller's transaction handle (`createPostgresTransactionBackend(tx)`, `createPostgresBackend(tx)` on a transaction handle, or `createSqliteBackend(tx)` over a Drizzle SQLite transaction whose driver frames transactions through Drizzle, such as libSQL's) cannot begin a transaction of its own: every write and every `store.transaction()` runs in a savepoint on the caller's transaction. Each call opened its own savepoint without regard to the others, so two calls started together nested one savepoint inside the other. When the outer call failed, its rollback removed the inner call's row although that call had already reported success; a create started while a `store.transaction()` was open landed inside it and was rolled back with it. On libSQL the second call instead queued behind the first, and deadlocked when the first awaited it.

Each such savepoint is now a unit of the caller's transaction. While one is open on a transaction handle, a call that would open another savepoint, or issue a statement of its own, on that handle is refused before it issues any statement. The bookkeeping is shared by every backend built over the same handle. Work the open call composes on its own savepoint (a backend built over the savepoint's handle, a nested savepoint) is not refused. Calls awaited one after another issue exactly the statements they did before.

Statements the application runs itself on its transaction handle are not TypeGraph calls and are not refused. One run while a TypeGraph call's savepoint is open still runs inside that savepoint and is rolled back if the call fails.

### Upgrade notes

- On a Store built over `createPostgresTransactionBackend(tx)` (or a SQLite backend over a Drizzle transaction), await each call before starting the next. Code that ran writes, reads or a `store.transaction()` beside one another under `Promise.all` now rejects all but the first with `TransactionCallRefusedError` (`details.reason: "savepoint-open"`). Inside `store.transaction()`, use the callback's `tx` for the writes that belong to it, and await it before using the Store again.
- Run the application's own statements on `tx` between TypeGraph calls, not while one is still running.
