---
"@nicia-ai/typegraph": minor
---

`bulkCreate` now batches its round trips end to end instead of degenerating
into per-row statements around one multi-row INSERT.

- Validation probes: per-row existence checks collapse into one `getNodes`
  per kind, and per-row uniqueness pre-checks into one `checkUniqueBatch`
  per (constraint, kind) — the batch validation caches are primed up front,
  so the per-row checks run against memory. Validation now runs as a
  synchronous first pass, so a later row's validation error can surface
  before an earlier row's constraint error (both fail the whole batch).
- Side effects: uniqueness entries write through a new `insertUniqueBatch`
  (multi-row conditional upsert with the same per-entry `UniquenessError`
  semantics), fulltext sync goes through the existing `upsertFulltextBatch`,
  and embedding sync through a new `upsertEmbeddingBatch` per
  (kind, field) — implemented for pgvector, sqlite-vec, and libSQL native
  vectors via an optional `VectorStrategy.buildUpsertBatch` seam with a
  per-row fallback for custom strategies.

Measured on the write bench (in-memory SQLite, 100-row batches of nodes
with searchable + embedding fields): ~1,600 → ~4,100 rows/s (~2.6×). The
win compounds on per-statement-networked engines (Turso, D1, Neon), where
each eliminated statement is a network round trip.
