---
"@nicia-ai/typegraph": minor
---

feat: facade search scoping — `store.search.{vector,fulltext,hybrid}` accept `where` (a property predicate compiled by the shared query compiler into the search statement's candidate set), `offset` (rank-relative pagination pushed into the engine), and `includeSubClasses` (search `subClassOf` descendants and merge into one ranking). Filters compile into the search statement's candidate set — exact on pgvector, sqlite-vec, tsvector, and FTS5, where a filtered search returns `limit` hits whenever enough matches exist; libSQL DiskANN post-filters a 4× over-fetched ANN set, so its recall against the filter is bounded by that headroom. Search now applies full current-read semantics (validity windows, not just tombstones), matching `find()`.
