---
"@nicia-ai/typegraph": minor
---

SQLite: implement `backend.vectorSearch`, unblocking `store.search.hybrid()` on SQLite.

The hybrid retrieval facade has been Postgres-only since #88: SQLite shipped fulltext (`fulltextSearch`) and embedding persistence (`upsertEmbedding` / `deleteEmbedding`), but never the `vectorSearch` method that `executeHybridSearch` requires for RRF fusion. `.similarTo()` on SQLite still worked because the predicate path goes through the query compiler, not the backend facade — but anyone reaching for `store.search.hybrid()` on SQLite hit `ConfigurationError: Backend does not support vector search`.

This release wires up the SQLite half of that contract:

- `buildVectorSearchSqlite` issues `vec_distance_cosine` / `vec_distance_l2` against the embeddings BLOB column, mirroring the Postgres SQL shape (same WHERE / ORDER BY / score expression / minScore semantics).
- `createSqliteBackend` exposes `vectorSearch` on the backend object whenever `hasVectorEmbeddings` is true (parallel to the existing `upsertEmbedding` gate).
- `inner_product` is rejected — sqlite-vec has no `vec_distance_ip` function.

```typescript
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";

const { backend } = createLocalSqliteBackend(); // sqlite-vec auto-loaded
const store = createStore(graph, backend);

const ranked = await store.search.hybrid("Document", {
  limit: 10,
  vector: { fieldPath: "embedding", queryEmbedding },
  fulltext: { query: "climate adaptation" },
});
```

**Performance.** On the standard search-shapes bench (500 docs, 384-dim), SQLite hybrid clocks in at **0.8ms** — about 3× faster than PostgreSQL's 2.5ms on the same shape. The bench harness now measures it on both backends; the previously-blank SQLite cell in the search comparison table is filled in.
