---
"@nicia-ai/typegraph": minor
---

Vector capabilities declare a new required `repeatableApproximateSearch` field: `{ repeatable: true }` when an approximate search returns the same rows on every execution over an unchanged database, or `{ repeatable: false, reason }`. pgvector and sqlite-vec declare it repeatable. libSQL declares it not repeatable, because DiskANN's `vector_top_k` starts each search from a randomly chosen node, and paging an approximate search there is refused. A custom vector strategy must now state the field.

Every vector search form, in the query builder and in `store.search.vector` and `store.search.hybrid`, now breaks distance ties by node id inside the engine's own top-`k` where the engine takes an order: pgvector keeps its HNSW or IVFFlat index scan and adds an incremental sort on the node id; libSQL and sqlite-vec scans add the same order. sqlite-vec's KNN cut takes no tiebreak and keeps its deterministic storage order. Which tied neighbors make the top `k` therefore no longer varies with the plan.

A zero-norm embedding no longer matches a cosine search. Its cosine distance is undefined: SQLite ranked it as the nearest neighbor, PostgreSQL as the furthest, and sqlite-vec's KNN let it displace a real neighbor from the top `k`. It is now excluded from every cosine search form on every backend, and a zero query embedding under cosine matches nothing. Writing a zero embedding is still accepted, since l2 and inner-product distances to it are defined.

A cursor whose value for an ordered field is not a value of that field (a string for a numeric field, an object for a string field) is now refused with a `ValidationError` on every query, instead of reaching the database as a type error or comparing across types.
