---
"@nicia-ai/typegraph": patch
---

Behavior change: a transaction handle retained past its callback now refuses writes. `store.transaction` and `store.transactionWithReceipt` seal the handle when the callback settles (commit or rollback) and a later node or edge write, or identity write, through the retained `tx` (or a retained `tx.measure` scope) throws a `ConfigurationError`. Previously this refusal applied only with `history: true`; otherwise the write succeeded, autocommitting on SQLite and appearing in no receipt.
