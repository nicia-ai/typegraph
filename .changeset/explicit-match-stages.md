---
"@nicia-ai/typegraph": minor
---

Add scoped `where()` filters for completed graph matches, independently of optional-match and recursive hop constraints. Add `stopExpansion()` with an explicit stopping-node emission policy. Preserve these stages in prepared queries, batches, and logical plans, and document ranked candidates, fanout, and distinct-entity counting.

Ranked candidate `k` no longer implicitly caps completed rows after traversal fanout, including set-operation operands. Use an explicit query `limit()` to bound the final row count.
