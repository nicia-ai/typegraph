---
"@nicia-ai/typegraph": patch
---

fix: facade search (`store.search.vector` / `fulltext` / `hybrid`) now computes top-k over live nodes in SQL. Previously the search statement ranked side-table rows alone and hydration dropped tombstoned ids afterward, silently returning fewer than `limit` hits under index drift. Liveness is pushed into the KNN/MATCH SQL on every engine — exact on pgvector (with `hnsw.iterative_scan = strict_order` on ≥0.8), sqlite-vec (vec0 primary-key `IN` pushdown), tsvector, and FTS5; libSQL DiskANN over-fetches 4× and post-filters (documented recall bound).
