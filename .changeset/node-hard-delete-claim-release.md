---
"@nicia-ai/typegraph": patch
---

A node hard delete (`hardDelete(id)` and `bulkHardDelete(ids)` on node collections) no longer leaves edge claim rows behind. The backend's cascade removes every incident edge row, live or tombstoned, but claims were released only for the live edges the store's `onDelete` verdict removed first, so a tombstoned incident edge's cardinality and composition claims, and those of a live composition edge removed by its part's own delete, survived. The leftover rows never refused a later write (a claim whose holder is gone is taken over in place); they only grew `typegraph_edge_claims`. The bundled `hardDeleteNode` and `hardDeleteNodesBatch` now release the claims of exactly the edge rows their DELETE returns, before the node row goes, independent of the current graph's cardinalities. A delete that removes no incident edge runs no extra statement; one that does runs one claim DELETE per bind-budget chunk of removed edges.

A claim purge on PostgreSQL now locks its rows in claim-target order before deleting them. It used to lock them in scan order, so an edge `bulkHardDelete` (and, with the release above, a node hard delete) purging tombstoned holders could deadlock against a concurrent create of an edge that bounds both endpoints and was taking over those holders' claims one at a time: PostgreSQL aborted one of the two with `40P01` (inside `store.transaction()`, a `TransactionConflictError`). The purge now waits for the create instead, and skips the rows the create took over.

Custom backends that declare `capabilities.constraintClaims` should release, in `hardDeleteNode` and `hardDeleteNodesBatch`, the claims of exactly the edge rows those members remove, and lock purged claim rows in claim-target order; the backend authoring guide states the contract. A backend that does not keeps working and leaves the same orphaned rows as before.

On a database bootstrapped before the edge claim relation existed, a node hard delete that removes an incident edge now reports `EDGE_CLAIM_RELATION_MISSING`, as removing a live incident edge already did. Run the generated migration SQL to create the relation.
