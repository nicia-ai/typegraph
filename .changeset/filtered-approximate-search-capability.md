---
"@nicia-ai/typegraph": minor
---

Declare, as a typed capability, whether a backend's filtered approximate vector
search can silently return a short page.

Every approximate (ANN) search TypeGraph issues carries at least one row filter —
the liveness predicate that hides soft-deleted and out-of-validity rows — and a
`.where(...)` predicate narrows it further. Where the engine applies that filter
relative to the index traversal decides whether the page fills:

- **`sqlite-vec`** pushes the filter into the `vec0` KNN candidate set. Exact —
  the only engine here that guarantees a full page.
- **`pgvector` ≥ 0.8** re-enters the index for more candidates
  (`hnsw.iterative_scan` / `ivfflat.iterative_scan`, applied automatically).
  Much better recall than a post-filter, but **not** a guarantee: the iterative
  scan stops at `hnsw.max_scan_tuples` / `ivfflat.max_probes`, and on
  **pgvector < 0.8** there is no iterative scan at all — the backend detects
  that at runtime, warns once, and the search stays `ef_search`-bounded.
- **`libsql-native`** cannot do either: DiskANN's `vector_top_k` is a table
  function with no filter pushdown. TypeGraph over-fetches `4 × (limit + offset)`
  neighbors and post-filters, so once more than that headroom is filtered out the
  search returns **fewer than `limit` rows even though more matches exist**.
  Heavy tombstone drift — routine in a temporal store — is what makes this real
  rather than theoretical.

That asymmetry was previously only a code comment. `VectorCapabilities` now
carries a required `filteredApproximateSearch: { mode, guaranteesFullPage }`.
**Read `guaranteesFullPage`, not `mode`** — `mode`
(`"filter-pushdown" | "iterative-scan" | "post-filter"`) names the mechanism the
strategy asks for, but only `guaranteesFullPage` reflects the runtime-dependent,
scan-bounded reality (it is `true` for `sqlite-vec` alone). It is documented in
the backend parity matrix, and boundary tests execute the difference against real
libSQL, sqlite-vec, and pgvector: the same 200-vector fixture, the same filter,
the same `limit`.

**Breaking for custom vector strategies only.** `VectorCapabilities` gained a
required field, so a hand-written `VectorStrategy` must now declare both its mode
and whether it guarantees a full page. That is deliberate: an omitted declaration
would inherit an engine promise the strategy may not keep.
