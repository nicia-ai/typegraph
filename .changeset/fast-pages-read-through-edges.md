---
"@nicia-ai/typegraph": minor
---

Add `store.batchOnce()` for exact-one-statement independent relational reads, plus one-statement `store.neighbors()` and `store.countNeighbors()` APIs for ordered, limited, and aggregate reads through edges. Add per-edge-kind ordering and limits to `subgraph()` traversal and hydration. Add `store.withCheckedReads()` to bind an expected schema version once across a fluent-query read block.
