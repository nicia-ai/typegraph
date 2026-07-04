---
"@nicia-ai/typegraph": patch
---

Non-approximate `.similarTo()` is now genuinely exact when an ANN index
exists. pgvector serves any `ORDER BY embedding <=> q LIMIT k` from a
matching HNSW/IVFFlat index, so after `materializeIndexes()` the
default (non-approximate) inline vector predicate silently returned
approximate results — measured recall 0.980 unfiltered and 0.000 under
a selective filter at 50k docs, where the index frontier starves at the
default ef_search and returns entirely wrong rows. The exact branch now
orders by `(distance + 0.0)`, which the index opclass cannot match,
forcing the true flat scan on every engine (numerically identity;
inert on SQLite/libSQL whose ANN forms are opt-in constructs).

Behavior change: exact queries that were silently index-served get
correct results and flat-scan latency (50k x 384 dims: ~39ms instead of
~23ms-but-wrong). The sanctioned fast path remains
`similarTo(..., { approximate: true })`, which is unchanged. The
`bench:vector` lane's `vector:exact-postindex-recall` and
`vector:exact-filtered-postindex-recall` rows now read 1.000.
