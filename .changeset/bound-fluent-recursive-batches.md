---
"@nicia-ai/typegraph": minor
---

Bound PostgreSQL `batchOnce()` planner costs with a combined allowance of 25 independent recursive plans. Each fluent recursive stage counts separately, including in composed reads; compatible subgraph roots count as one plan per group. Refuse oversized batches with `ConfigurationError` before execution while preserving the one-statement contract. The existing subgraph budget remains within this combined allowance.

### Upgrade notes

- Split PostgreSQL `batchOnce()` reads into explicit calls when their fluent recursive stages plus combined subgraph groups exceed 25. `shareSubgraphs` does not combine fluent recursive queries.
