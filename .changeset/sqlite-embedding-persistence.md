---
"@nicia-ai/typegraph": patch
---

Persist vector embeddings on the SQLite backend when sqlite-vec is loaded.

Previously, `store.nodes.X.create({ ..., embedding: [...] })` on SQLite validated the embedding and inserted the node, but the embedding itself was silently dropped — the SQLite backend didn't implement `upsertEmbedding`/`deleteEmbedding`, so the store's embedding-sync path quietly no-op'd. Vector predicates like `d.embedding.similarTo(q, 20, { metric: "cosine" })` then ran against an empty `typegraph_node_embeddings` table and returned zero rows without error.

This release wires up both methods on the SQLite backend. They encode embeddings to `vec_f32('[...]')` BLOBs on write and rely on sqlite-vec at query time — same storage shape the existing `.similarTo()` compilation already targets. Activation is opt-in via a new `hasVectorEmbeddings` option on `createSqliteBackend` so callers that haven't loaded sqlite-vec don't hit `no such function: vec_f32` at write time. `createLocalSqliteBackend` best-effort-loads sqlite-vec at startup and flips the option automatically, so the common local setup works without configuration.

```typescript
// Local backend: sqlite-vec is loaded automatically when installed.
const { backend } = createLocalSqliteBackend();

// BYO drizzle connection: pass hasVectorEmbeddings after loading sqlite-vec.
import sqliteVec from "sqlite-vec";
sqliteVec.load(sqlite);
const backend = createSqliteBackend(drizzle(sqlite), { tables, hasVectorEmbeddings: true });
```

`getEmbedding` and the hybrid-search facade (`store.search.hybrid(...)`) remain PostgreSQL-only — decoding the raw BLOB back to `number[]` via `vec_to_json` and exposing a hybrid-search backend method are tracked separately.
