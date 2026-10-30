---
"@nicia-ai/typegraph": minor
---

Fix live edges left on deleted nodes.

- On PostgreSQL, an edge created concurrently with a delete of one of its endpoints could stay live on the deleted node. The edge write checked endpoint liveness with a plain read and the delete read connected edges with a plain read, so each could miss the other's uncommitted write. Edge writes now lock both endpoint rows `FOR KEY SHARE` when they check liveness — inside the statement on single-statement paths, through a locked read in the same transaction on the portable path — and node deletes (single, bulk, hard, and the closed restrict-delete program) lock their rows `FOR UPDATE` before reading connected edges: the pairing a foreign key makes. Whichever write runs second now waits for the first: an edge write after a delete is refused with `EndpointNotFoundError` (or `TransactionConflictError` above READ COMMITTED), and a delete after an edge write sees the edge and removes or refuses it by its `onDelete` behavior. Both sides lock in (kind, id) code-point order. One case stays open and is documented: a REPEATABLE READ or SERIALIZABLE delete whose snapshot predates the edge write's commit still misses the edge. The safe choices are to delete at READ COMMITTED, or to run both the delete and the edge writers at SERIALIZABLE. SQLite was never affected because writers take the single writer slot, and its writes pay no extra lock statements.
- Resurrecting a tombstoned edge whose endpoint had since been deleted revived it as a live edge on the deleted node, on every backend and without any concurrency. `getOrCreateByEndpoints()`, `bulkGetOrCreateByEndpoints()` and `bulkUpsertById()` now check both endpoints before a resurrection, under the same lock, and refuse with `EndpointNotFoundError`.
- A durable-identity convergence (`matchIdentity`) racing a hard delete of its incumbent edge and endpoint could insert a fresh live edge on the deleted node; the incumbent check now locks the incumbent row, so it re-evaluates after the delete commits.
- `importGraph` checks every endpoint it did not write itself under the same lock, on its set-oriented path and on its per-row path for duplicate ids alike.
- `store.clear()` now deletes nodes before edges, so an edge committed while the clear waited is removed rather than left live with both endpoints gone.
- The portable batch node update (`bulkUpsertById` / `bulkReplaceById` update leg) locks its rows `FOR NO KEY UPDATE` instead of `FOR UPDATE`, so it no longer deadlocks with edge writes to the same nodes.

Behavior changes to expect:

- A resurrection whose endpoint is deleted now throws `EndpointNotFoundError` instead of reviving the edge.
- On PostgreSQL, an edge write and a delete of one of its endpoints now wait for each other, and can deadlock when a transaction deletes both endpoints of an edge being created in another order, or writes several edges at once. PostgreSQL aborts one of the two with `TransactionConflictError`, retryable with `store.transaction(fn, { retry })`.

### Breaking

- `GraphBackend` gains a required `lockNodes(graphId, kind, ids, lock)` member, the read every store edge write's endpoint check and every store node delete's preflight goes through. The contract: return the rows `getNodes(graphId, kind, ids)` returns, live and tombstoned alike, acquired in code-point order of `id`, and held locked until the surrounding transaction ends — `"edgeEndpoint"` with a lock that admits other endpoint locks and ordinary row updates but waits on a delete's lock (PostgreSQL `FOR KEY SHARE`), `"delete"` with a lock that waits on every endpoint lock (PostgreSQL `FOR UPDATE`). On an engine whose writers serialize, the plain ordered read is a complete implementation.

  **Migrating a custom backend:** the bundled backends already implement `lockNodes` on every driver, so only a hand-written `GraphBackend` needs a change, and it fails to type-check until it has one. On an engine that admits one writer at a time, implement it as your `getNodes` read with the rows sorted by `id`. On an engine with concurrent writers, issue the same read with `ORDER BY id COLLATE "C"` and the lock clause for `lock` (`FOR KEY SHARE` or `FOR UPDATE` on PostgreSQL) inside the caller's transaction; without those locks the store cannot keep a live edge off a deleted endpoint on your backend.
