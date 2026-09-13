---
"@nicia-ai/typegraph": minor
---

Add `store.batchOnce()` for exact-one-statement independent reads, including composable neighbor, neighbor-count, and subgraph query helpers. Add one-statement `store.neighbors()` and `store.countNeighbors()` APIs with edge- or adjacent-node ordering, limits, and aggregates. Add per-edge-kind direction, ordering, and limits to `subgraph()` traversal and hydration. Add `store.withCheckedReads()` to bind an expected schema version once across a fluent-query read block.
