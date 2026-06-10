---
"@nicia-ai/typegraph": minor
---

Close the TOCTOU windows in graph-merge commits. A merge resolves its plan from reads taken before the commit transaction, so a write landing on the target in between could previously be committed over. Now, inside the commit transaction: `merge()` and `mergeAgainstBase()` re-validate the target's base@V content fingerprint, and `mergeIncremental()` re-runs its new-vs-base identity resolution (the unique-constraint and block-index probes). All three fail with `BaseVersionMismatchError` — instead of committing a stale plan or a duplicate entity — when the target changed in that window. Merge commits run at `SERIALIZABLE` isolation with bounded retry on serialization failures and deadlocks, making the guards race-free on multi-writer Postgres. `Store.transaction()` accepts optional `TransactionOptions` (isolation level) and `TransactionContext` exposes the transaction-scoped `backend`.
