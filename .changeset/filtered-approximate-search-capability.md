---
"@nicia-ai/typegraph": minor
---

Declare, as a typed capability, whether a backend's filtered approximate vector
search can silently return a short page.

Every approximate (ANN) search TypeGraph issues carries at least one row filter —
the liveness predicate that hides soft-deleted and out-of-validity rows — and a
`.where(...)` predicate narrows it further. Where the engine applies that filter
relative to the index traversal decides whether the page fills:

- **`sqlite-vec`** pushes the filter into the `vec0` KNN candidate set. Exact.
- **`pgvector` ≥ 0.8** re-enters the index until `LIMIT` rows survive the filter
  (`hnsw.iterative_scan` / `ivfflat.iterative_scan`, applied automatically).
- **`libsql-native`** cannot do either: DiskANN's `vector_top_k` is a table
  function with no filter pushdown. TypeGraph over-fetches `4 × (limit + offset)`
  neighbors and post-filters, so once more than that headroom is filtered out the
  search returns **fewer than `limit` rows even though more matches exist**.
  Heavy tombstone drift — routine in a temporal store — is what makes this real
  rather than theoretical.

That asymmetry was previously only a code comment. `VectorCapabilities` now
carries a required `filteredApproximateSearch` field
(`"filter-pushdown" | "iterative-scan" | "post-filter"`), it is documented in the
backend parity matrix, and boundary tests execute the difference against real
libSQL and real sqlite-vec: the same 200-vector fixture, the same filter, the same
`limit` — libSQL returns a short page, sqlite-vec returns a full one.

**Breaking for custom vector strategies only.** `VectorCapabilities` gained a
required field, so a hand-written `VectorStrategy` must now declare which of the
three shapes its engine implements. That is deliberate: an omitted declaration
would inherit an engine promise the strategy may not keep.
