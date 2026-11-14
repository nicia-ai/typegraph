---
"@nicia-ai/typegraph": minor
---

Compile compatible `batchOnce()` subgraph reads through one origin-keyed recursive traversal even when `shareSubgraphs` is false, avoiding hundreds of independent PostgreSQL recursive plans at the 500-read cap. Default batches retain per-request entity payloads; `shareSubgraphs: true` still deduplicates payloads with request memberships.

Preserve the default per-request JSON aggregation limit and avoid deep-copying already independent payloads. PostgreSQL now refuses batches with more than 25 independent subgraph plans after compatible reads are combined, using a typed `ConfigurationError` that recommends aligning options or explicitly splitting the batch. This planner budget applies in both payload modes.

### Upgrade notes

- PostgreSQL `batchOnce()` now refuses more than 25 independent subgraph plans after compatible reads are combined. Align subgraph options or split the batch into explicit `batchOnce()` calls.
