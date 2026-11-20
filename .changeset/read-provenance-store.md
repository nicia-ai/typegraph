---
"@nicia-ai/typegraph": minor
---

Add `readProvenanceStore(backend, targetGraphId)` to `@nicia-ai/typegraph/graph-merge`, a read-only counterpart to `openProvenanceStore`. It runs the same ownership inspection but never writes (no ownership marker, no schema registration, no DDL), so it works under a role that can only SELECT. It resolves to `undefined` when the target has no persisted provenance, to the sidecar store when the id is owned, and throws the same `GRAPH_MERGE_PROVENANCE_ID_COLLISION` error as `openProvenanceStore` when the id is occupied by something else.
