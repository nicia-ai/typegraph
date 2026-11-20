---
"@nicia-ai/typegraph": minor
---

An edge hard delete now releases cardinality and composition claims only for the rows its DELETE actually removed. The delete asserts the kind it resolved, so when a concurrent writer removes the edge and commits another constrained edge under the same id between the lookup and the DELETE, the statement matches nothing and the replacement survives — but the claim release was keyed by id alone and stripped the replacement's claim, leaving a live constrained edge no claim fenced. `hardDelete`, `bulkHardDelete` and the node delete cascade all release by removed rows now. To report them, the backend port `hardDeleteEdge` now resolves `true` when it removed the row and `false` when it matched none, and the optional `hardDeleteEdgesBatch` resolves the ids of the rows it removed; the bundled backends return them from the DELETE itself. A custom backend must return these values.
