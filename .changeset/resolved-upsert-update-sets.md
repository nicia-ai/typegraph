---
"@nicia-ai/typegraph": minor
---

Reduce eligible update-only node and edge `bulkUpsertById()` calls on bundled serverless backends to one batched preimage read plus one guarded atomic set update. Consolidate fallback updates under one write plan and batch their authoritative reads when transaction semantics allow it.
