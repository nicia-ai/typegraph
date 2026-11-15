---
"@nicia-ai/typegraph": minor
---

Bound PostgreSQL `batchOnce()` planner costs with one allowance of 25 independent recursive plans. Each emitted fluent recursive stage and historical identity ledger reconstruction counts separately, including in composed reads; compatible subgraph roots count as one plan per group. Refuse oversized batches with `ConfigurationError` before execution while preserving the one-statement contract.

### Upgrade notes

- Split PostgreSQL `batchOnce()` reads into explicit calls when their emitted recursive plans exceed 25. Historical identity expansion consumes a slot even without `.recursive()`. `shareSubgraphs` does not combine fluent queries. If a single composed read exceeds the allowance, simplify it or use standalone `.execute()`, which does not impose this batch budget.
