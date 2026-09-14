---
"@nicia-ai/typegraph": minor
---

Add `store.batchOnce()` for exact-one-statement independent reads, with a batch-scoped builder for composable neighbor, neighbor-count, and subgraph reads. Add one-statement `store.neighbors()` and `store.countNeighbors()` APIs with edge- or adjacent-node ordering, limits, and aggregates. Add per-edge-kind direction, ordering, and limits to `subgraph()` traversal and hydration. Direct `store.subgraph()` and batch-scoped `read.subgraph()` share result semantics while choosing backend-tuned and exact-one-statement physical plans, respectively. Add `store.withCheckedReads()` to bind an expected schema version once across a fluent-query read block.
