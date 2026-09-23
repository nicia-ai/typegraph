---
"@nicia-ai/typegraph": patch
---

Two write paths now honor identity exactly as the ordinary node writes do. A provenance retraction that closes a fact's currency detaches the fact from its identity class, ending its open identity assertions as any soft delete does, and a reopen folds it back in as a restore; previously a closed fact kept its open assertions and stayed in its class while tombstoned. `bulkUpsertById` items that set `validTo` now go through the same identity check as `update` and `upsertById`, so a window end that an open identity assertion would outlive is refused with `IdentityEndpointValidityError` instead of committing.

A standalone schema commit (`migrateSchema`, `initializeSchema` or `ensureSchema` called without a Store) now keeps recorded history for a graph TypeGraph captures: its identity ledger deletions (kind-drop cascades, enablement purges) close their recorded rows and its identity transitions are noted, where previously both were silently dropped. Whether a graph captures is read from the database inside the commit transaction — a graph with TypeGraph-recorded node history captures, one using only `revisionTracking` or engine-native recorded time does not. A store open with `history: true` on an engine-native backend no longer binds TypeGraph capture to its schema commit.
