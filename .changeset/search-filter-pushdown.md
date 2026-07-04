---
"@nicia-ai/typegraph": minor
---

feat: facade search scoping — `store.search.{vector,fulltext,hybrid}` accept `where` (a property predicate compiled by the shared query compiler into the search statement's candidate set), `offset` (rank-relative pagination pushed into the engine), and `includeSubClasses` (search `subClassOf` descendants and merge into one ranking). Filters happen inside the engine's top-k, never by post-filtering — a filtered search returns `limit` hits whenever enough matches exist. Search now applies full current-read semantics (validity windows, not just tombstones), matching `find()`.
