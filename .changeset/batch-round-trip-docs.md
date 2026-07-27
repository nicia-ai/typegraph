---
"@nicia-ai/typegraph": patch
---

State `store.batch()`'s real cost where callers see it. `batch()` issues
`begin`, one statement per query, then `commit` — N queries are N+2 round trips
— so it collapses connection acquisition, not latency, and will not fix an N+1.
The docstrings for `batch()`, `BatchableQuery`, and the edge `batchFind*`
methods now lead with that, and point at `.traverse()`, `store.subgraph()`, and
`getByIds()` / `bulkFindByIndex()` as the round-trip-collapsing alternatives.
The docs site claim that `batch()` "minimizes round-trips for reads" is
corrected. Behavior is unchanged.
