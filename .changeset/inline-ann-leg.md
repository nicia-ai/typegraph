---
"@nicia-ai/typegraph": patch
---

Inline `.similarTo(..., { approximate: true })` now actually uses the
ANN index on PostgreSQL. Two defects compounded: the candidates
membership subquery carried a `DISTINCT` that kept the planner off the
ordered index scan entirely (even `enable_seqscan = off` could not
rescue it — duplicates are irrelevant to `IN` membership, so the
DISTINCT bought nothing), and the inline path never applied the
pgvector GUCs the search facade uses, so even an index-served filtered
scan would have starved at the default ef_search frontier. The compiler
now emits duplicate-tolerant membership candidates for the engine-form
branch and brands ANN-bearing statements; the PostgreSQL backend wraps
branded statements with the facade's GUC overrides
(`hnsw.iterative_scan = strict_order` / `ivfflat.iterative_scan =
relaxed_order` on pgvector >= 0.8). Measured at 50k x 384 dims:
unfiltered approximate 174ms -> 2.1ms (recall 0.995), filtered
approximate 3.8ms at recall 1.000 on filter-independent corpora. The
JOIN consumers of the scoped candidates (exact branch, fulltext CTE)
keep their DISTINCT — a join does multiply rows on duplicates — and the
non-approximate path's exactness guarantee is untouched.
