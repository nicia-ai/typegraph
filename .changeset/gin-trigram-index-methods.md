---
"@nicia-ai/typegraph": minor
---

Property filters that a btree can never serve now have a declarative index
story: `defineNodeIndex` / `defineEdgeIndex` accept
`method: "gin" | "trigram"` (default `"btree"`, unchanged).

- `method: "gin"` emits a PostgreSQL expression GIN (`jsonb_path_ops`) over
  the field's jsonb extraction, serving the array containment predicates
  (`contains` / `containsAll` / `containsAny` on array fields). Verified to
  match TypeGraph's compiled `(props #> ARRAY[…]) @> $1` form under
  parameterized prepared statements — note that a hand-written
  whole-column `GIN (props)` never matches these expressions (the previous
  docs guidance recommended one; corrected).
- `method: "trigram"` emits an expression GIN with `gin_trgm_ops` over the
  field's text extraction, serving substring and case-insensitive matches
  (`contains` / `startsWith` / `endsWith` / `like` / `ilike` on string
  fields). `materializeIndexes()` installs `pg_trgm`
  (`CREATE EXTENSION IF NOT EXISTS`) on first use.

Both are materialize-only (like vector ANN indexes) and PostgreSQL-only:
`materializeIndexes()` reports them as `skipped` on SQLite, whose
substring-search story is FTS5 fulltext. GIN-family declarations take
exactly one field and reject `unique`, `coveringFields`, and `where`;
`method: "btree"` is canonicalized by absence so existing stored schema
documents and materialization signatures are unchanged. `bulkFindByIndex`
rejects GIN-family indexes (it compiles equality probes, which only btree
declarations serve).
