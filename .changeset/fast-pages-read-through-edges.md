---
"@nicia-ai/typegraph": minor
---

Add `store.batchOnce()` for exact-one-statement independent reads, with a scoped callback builder for composable neighbor, neighbor-count, and subgraph reads. Add one-statement `store.neighbors()` and `store.countNeighbors()` APIs with edge- or adjacent-node ordering, limits, and aggregates. Add per-edge-kind direction, ordering, and limits to `subgraph()` traversal and hydration, with direct and scoped subgraph reads sharing one semantic planner while retaining backend-tuned execution. Add `store.withCheckedReads()` to bind an expected schema version once across a fluent-query read block.
