---
"@nicia-ai/typegraph": minor
---

Accept `validFrom: null` on Store node and edge creation and upsert inputs to explicitly request an open-left validity window. Omitted lower bounds keep their existing default behavior; live-row upserts still refuse changes to an immutable lower bound.

Preserve open-left staged node and edge windows through snapshot and incremental graph merges, edge repointing, and serialized merge plans instead of narrowing them to the merge commit time. Keep repeated bulk-upsert coalescing from confusing an unknown creation timestamp with a confirmed open-left bound.
