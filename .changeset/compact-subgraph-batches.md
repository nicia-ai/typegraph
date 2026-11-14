---
"@nicia-ai/typegraph": minor
---

Compile compatible `batchOnce()` subgraph reads through one origin-keyed recursive traversal even when `shareSubgraphs` is false, avoiding hundreds of independent PostgreSQL recursive plans at the 500-read cap. Default batches retain per-request entity payloads; `shareSubgraphs: true` still deduplicates payloads with request memberships.

Preserve the default per-request JSON aggregation limit and avoid deep-copying already independent payloads. Each compatible subgraph group consumes one slot in PostgreSQL’s shared allowance of 25 independent recursive plans per batch, alongside recursive plans emitted by relational reads, including historical identity reconstruction. Exceeding the shared allowance throws a typed `ConfigurationError` before execution. The allowance applies in both payload modes.

### Upgrade notes

- Keep PostgreSQL `batchOnce()` within its shared allowance of 25 independent recursive plans. Compatible subgraph roots combine into one plan per group. Align subgraph options or split reads into explicit `batchOnce()` calls; if one composed read alone exceeds the allowance, simplify it or use standalone `.execute()`.
