---
"@nicia-ai/typegraph": patch
---

Compile compatible `batchOnce()` subgraph reads through one origin-keyed recursive traversal even when `shareSubgraphs` is false, avoiding hundreds of independent PostgreSQL recursive plans at the 500-read cap. Default batches retain per-request entity payloads; `shareSubgraphs: true` still deduplicates payloads with request memberships.
