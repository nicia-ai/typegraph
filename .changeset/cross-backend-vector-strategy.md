---
"@nicia-ai/typegraph": minor
---

Add cross-backend vector and hybrid search through a pluggable
`VectorStrategy`, closing #157. TypeGraph now has first-class vector storage and
search for libSQL/Turso, sqlite-vec, and pgvector behind the same semantic
search APIs.

Backend highlights:

- libSQL/Turso stores fixed-dimension embeddings in `F32_BLOB(N)` columns,
  supports cosine/L2 search, and can use DiskANN through `libsql_vector_idx`
  and `vector_top_k`.
- sqlite-vec uses `vec0` KNN tables instead of brute-force vector scans.
- pgvector uses graph-scoped, per-field `vector(N)` tables with HNSW/IVFFlat
  materialization.
- Backends advertise vector metrics, index types, and dimension limits from the
  active strategy, and `createSqliteBackend` / `createPostgresBackend` accept a
  custom `vector?: VectorStrategy`.

The release also adds migration and lifecycle tooling for the new storage model:

- `migrateLegacyEmbeddings(...)` copies existing rows out of the legacy shared
  `typegraph_node_embeddings` table.
- `store.reembedVectorField(kind, fieldPath, { embed? })` recreates a field's
  storage after an embedding dimension change and can re-embed existing rows.
- `store.materializeRemovals()` reclaims vector tables for removed embedding
  fields and reports them in `MaterializeRemovalsResult.reclaimedVectorFields`.

**Breaking storage change:** vector embeddings now live in graph-scoped,
fixed-dimension per-field storage instead of the shared
`typegraph_node_embeddings` table. Search no longer reads the legacy table.
Deployments with existing embeddings must run `migrateLegacyEmbeddings(...)`
once after upgrading; deployments without stored embeddings need no migration.
