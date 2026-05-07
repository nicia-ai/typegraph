---
"@nicia-ai/typegraph": minor
---

Unify vector indexes through the same declaration channel as relational indexes. Vector indexes are now auto-derived from `embedding()` brands at `defineGraph()` time and flow through `Store.materializeIndexes()` like any other index. Closes the second of two PRs needed to ship #101 properly.

## What changed

```typescript
const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    // Auto-derives a cosine HNSW vector index with pgvector defaults.
    embedding: embedding(384),
  }),
});

// Override the auto-derived defaults at the brand site.
const Image = defineNode("Image", {
  schema: z.object({
    embedding: embedding(512, { metric: "l2", m: 32, efConstruction: 100 }),
  }),
});

// Opt out of automatic materialization while keeping the embedding column.
const Manual = defineNode("Manual", {
  schema: z.object({
    embedding: embedding(384, { indexType: "none" }),
  }),
});

const [store] = await createStoreWithSchema(graph, backend);
const result = await store.materializeIndexes();
// Postgres+pgvector → status: "created"
// SQLite (or `indexType: "none"`) → status: "skipped" with reason
```

## API additions

- `embedding(dimensions, options?)` — `options` is the new
  `EmbeddingIndexOptions` carrying `metric`, `indexType`, HNSW `m` /
  `efConstruction`, and IVFFlat `lists`. Defaults: `cosine` /
  `hnsw` / `m=16` / `efConstruction=64` (pgvector defaults).
- `EmbeddingMetric`, `EmbeddingIndexType`, `EmbeddingIndexOptions`,
  `ResolvedEmbeddingIndex` — exported types.
- `getEmbeddingIndex(schema)` — read the resolved index config from
  an embedding brand.
- `IndexDeclaration` — now a discriminated union of
  `NodeIndexDeclaration | EdgeIndexDeclaration | VectorIndexDeclaration`.
- `RelationalIndexDeclaration` — alias for the relational subset
  (the variants `generateIndexDDL` consumes).
- `VectorIndexDeclaration`, `VectorIndexMetric`,
  `VectorIndexImplementation`, `VectorIndexParams` — exported types.
- `MaterializeIndexesEntry.entity` — extended to include `"vector"`.
- `MaterializeIndexesEntry.status` — new variant `"skipped"` with a
  `reason` field. Surfaces when the backend recognizes the
  declaration but can't act on it (vector indexes against SQLite
  without `sqlite-vec`, or `indexType: "none"`).

## Auto-derivation

At `defineGraph()` time, every top-level node field declared with
`embedding()` produces one `VectorIndexDeclaration`. The declarations
flow through `GraphDef.indexes` and `SerializedSchema.indexes` like
relational indexes. v1 limits:

- One vector index per (kind, fieldPath). To use a different metric
  for the same field, use a different field name or wait for v2.
- Top-level fields only. Embeddings nested inside object properties
  are not auto-derived (pgvector's column-based indexes don't address
  sub-paths cleanly).

Explicit `VectorIndexDeclaration` entries passed via
`defineGraph({ indexes })` win on (kind, fieldPath) collisions, so
consumers can override defaults without losing auto-derivation for
other fields.

## Materialization dispatch

`materializeIndexes()` reads `IndexDeclaration.entity` and dispatches:

- `node` / `edge` → existing path: `generateIndexDDL` →
  `executeDdl`.
- `vector` → calls `backend.createVectorIndex(params)` with the
  resolved metric, indexType, dimensions, and HNSW / IVFFlat params.

Status tracking goes through the existing
`typegraph_index_materializations` table; the `entity` column was
widened to accept `"vector"`. Signature includes vector params for
drift detection.

## Capability checks

`materializeIndexes()` checks `backend.capabilities.vector?.supported`
and `backend.capabilities.vector.indexTypes` before dispatching. When
the backend can't handle the requested vector indexType, the entry
reports `status: "skipped"` with a clear reason rather than silently
returning `"created"` for a no-op.

## Backend interface cleanup

Removed dead code from `GraphBackend`:

- `createFulltextIndex?` — never called from anywhere in the store
  layer; the fulltext table's canonical index is created with the
  table itself by `bootstrapTables`.
- `dropFulltextIndex?` — same.

Custom backends implementing these methods will need to remove them.
Pre-1.0 acceptable.

## Out of scope (still deferred)

- **Fulltext index unification.** Fulltext stays per-strategy in v1;
  the GIN / FTS5 index is created with the fulltext table at
  `bootstrapTables` time.
- **Multiple vector indexes per (kind, field).** v1 allows at most
  one. Use a different field name for now.
- **Vector indexes for runtime-declared kinds.** Auto-derivation
  walks compile-time node schemas. Runtime-extension documents can't
  yet declare embeddings — coming in a follow-up.
