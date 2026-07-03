---
"@nicia-ai/typegraph": minor
---

`importGraph` now processes each `batchSize` slice with batched round trips
instead of fully single-row statements. Nodes: one `getNodes` per kind for
existence, one `checkUniqueBatch` per (constraint, kind) for uniqueness
pre-checks, one multi-row insert, and one batched side-effect pass
(uniqueness entries, fulltext, embeddings) for the accepted creates.
Edges: one `getNodes` per endpoint kind for reference liveness, one
`getEdges` for existence, and one multi-row insert.

Per-row semantics are unchanged: conflicts route by `onConflict`, a
uniqueness conflict is recorded as a per-row error entry (the rest of the
import proceeds), reference validation still rejects missing or tombstoned
endpoints, and rows repeating an id within a slice fall back to the
per-row path so they observe the first occurrence's row exactly as before.

Measured on the write bench (in-memory SQLite, 500 nodes + 500 edges per
import): ~26k → ~96k entities/s (~4×). The win compounds on
per-statement-networked engines (Turso, D1, Neon), where the old path paid
one round trip per row and the new one pays a handful per slice.
