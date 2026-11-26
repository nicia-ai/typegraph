---
"@nicia-ai/typegraph": patch
---

`createPostgresBackend(tx)` and `createPostgresTransactionBackend(tx)` now refuse `capabilities.execution.commitOutcome: "commit-reply"` with a `ConfigurationError` (`details.code: "TRANSACTION_SCOPED_COMMIT_OUTCOME"`). A backend over a caller's transaction opens savepoints, whose commit only the caller observes, so it never advertises that evidence itself; but forwarding a root backend's `capabilities` restored the declaration, the backend's `transaction()` then treated a savepoint's release as the commit, overwrote the enclosing transaction's outcome marker, and the enclosing `transaction()` call failed with `TransactionOutcomeUnknownError`. Omit `execution.commitOutcome` when forwarding a root backend's capabilities to a backend over a transaction.
