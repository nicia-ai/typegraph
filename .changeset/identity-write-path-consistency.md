---
"@nicia-ai/typegraph": minor
---

Three write paths now honor identity exactly as the ordinary node writes do. `importGraph` with `onConflict: "update"` sends a document's node `validTo` through the same identity check: an end an open identity assertion would outlive is reported as a per-row error carrying the `IdentityEndpointValidityError` message and the row is left unchanged, and an end that lands on an identity class member records the `window-end` transition (a row the import then refuses records none). A provenance retraction that closes a fact's currency detaches the fact from its identity class, ending its open identity assertions as any soft delete does, and a reopen folds it back in as a restore; previously a closed fact kept its open assertions and stayed in its class while tombstoned. `bulkUpsertById` items that set `validTo` go through the same identity check as `update` and `upsertById`.

A standalone schema commit (`migrateSchema`, `initializeSchema` or `ensureSchema` called without a Store) now keeps recorded history for a graph TypeGraph captures: its identity ledger deletions (kind-drop cascades, enablement purges) close their recorded rows and its identity transitions are noted, where previously the recorded rows were left open. Whether a graph captures is read from the database inside the commit transaction — a graph with TypeGraph-recorded node history captures, one using only `revisionTracking` or engine-native recorded time does not. A store open with `history: true` on an engine-native backend no longer binds TypeGraph capture to its schema commit.

`store.changesSince(anchor)` on a history-capturing store now answers `unbounded` for a span in which an identity assertion was created, retracted or ended, as its documentation states and as the revision-journal source already did. The lineage source graph merge prunes by is unchanged and stays bounded across identity writes.

### Breaking

- `bulkUpsertById` items that set `validTo` are refused with `IdentityEndpointValidityError` when an open identity assertion would outlive the end, where they previously committed. End the assertion first or drop the `validTo`.
- `importGraph` with `onConflict: "update"` reports a node `validTo` an open identity assertion would outlive as a per-row error and leaves the row unchanged, where it previously stored the end. End the assertion on the target first, or drop the `validTo` from the document.
- The internal `TransactionRuntime` port loses `runNodeOperationHooks` and gains `deleteNodeWithPolicy`: the provenance fact close and reopen path now deletes and revives through the transaction's own node operations under its buffered hooks. The port is symbol-keyed and not exported from any entrypoint, so only code that reaches into the transaction runtime directly is affected.
- `store.changesSince(anchor)` on a history-capturing store answers `unbounded` for a span holding an identity write, where it previously returned an exact node and edge key list that omitted the identity change, so a span holding only an identity write read as an empty delta. A consumer that read that list as a complete delta must handle `unbounded`.
