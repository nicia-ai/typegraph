---
"@nicia-ai/typegraph": minor
---

Fix live edges left on deleted nodes.

- On PostgreSQL, an edge created concurrently with a delete of one of its endpoints could stay live on the deleted node. The edge write checked endpoint liveness with a plain read and the delete read connected edges with a plain read, so each could miss the other's uncommitted write. Edge writes now lock both endpoint rows `FOR KEY SHARE` in the statement that checks their liveness, and node deletes (single, bulk, hard, and the closed restrict-delete program) lock their rows `FOR UPDATE` before reading connected edges — the pairing a foreign key makes. Whichever write runs second now waits for the first: an edge write after a delete is refused with `EndpointNotFoundError` (or `TransactionConflictError` above READ COMMITTED), and a delete after an edge write sees the edge and removes or refuses it by its `onDelete` behavior. Endpoint locks do not conflict with each other or with ordinary node updates. One case stays open and is documented: a REPEATABLE READ or SERIALIZABLE delete whose snapshot predates the edge write's commit still misses the edge unless both writers run at SERIALIZABLE. SQLite was never affected because writers take the single writer slot.
- Resurrecting a tombstoned edge whose endpoint had since been deleted revived it as a live edge on the deleted node, on every backend and without any concurrency. `getOrCreateByEndpoints()`, `bulkGetOrCreateByEndpoints()` and `bulkUpsertById()` now check both endpoints before a resurrection, under the same lock, and refuse with `EndpointNotFoundError`.
- A durable-identity convergence (`matchIdentity`) racing a hard delete of its incumbent edge and endpoint could insert a fresh live edge on the deleted node; the incumbent check now locks the incumbent row, so it re-evaluates after the delete commits.

### Breaking

- `GraphBackend` gains a required `lockNodes(graphId, kind, ids, lock)` member, the read every edge write's endpoint check and every node delete's preflight now goes through. The bundled backends implement it on every driver. A custom `GraphBackend` must add it: return the rows `getNodes` returns, ordered by `id`, locked until the transaction ends (`FOR KEY SHARE` for `"edgeEndpoint"`, `FOR UPDATE` for `"delete"` on PostgreSQL). An engine that admits one writer at a time may return its plain `getNodes` read.
