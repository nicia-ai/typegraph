---
"@nicia-ai/typegraph": minor
---

Add revision-anchored graph branches and streaming interchange. Stores can opt
into `revisionTracking: true` (or use `history: true`) so branch and merge
validation read a durable per-graph origin and revision instead of
fingerprinting every live row or accepting a coincident revision from another
store. Physical branch clones now stream bounded interchange batches, enabling
large branch copies, exports, and imports without materializing the full graph
in memory. Direct backend writes remain outside the revision-tracking contract;
tracked stores fail loudly if `tx.sql` would bypass that contract.
