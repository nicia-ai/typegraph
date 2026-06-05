---
"@nicia-ai/typegraph": minor
---

Add `store.nodes.<Kind>.bulkFindByIndex(indexName, items, options?)` — batched candidate retrieval against declared node indexes, including non-unique ones. For each input record it returns the live nodes that share that record's declared index key, for import reconciliation, dedup-candidate discovery, and joining records against the graph by a composite key. Each input yields its own array (candidate retrieval, not a uniqueness guarantee); buckets preserve input order and are ordered by node id.

TypeGraph owns the index semantics: keys are computed from `index.fields` only (reusing the index's own extraction expressions), the partial `where` is applied to stored rows, and a missing/`undefined` indexed field matches a stored `NULL` via a new null-safe-equality dialect adapter. An optional `limitPerInput` caps each bucket — in SQL via `ROW_NUMBER()` when the backend supports window functions, otherwise capped in memory with the same result. Date-typed key fields are rejected with `ConfigurationError` because they can't compare identically across SQLite and PostgreSQL. Unknown index names throw `NodeIndexNotFoundError`.

`createLocalSqliteBackend` also gains a `capabilities` override for simulating engine capability gaps (e.g. `windowFunctions: false`) in tests.
