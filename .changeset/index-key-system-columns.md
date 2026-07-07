---
"@nicia-ai/typegraph": minor
---

`defineNodeIndex` accepts a new `keySystemColumns` option: system columns
(e.g. `"id"`) to include in the index key, positioned after the `scope`
prefix and before `fields`/`coveringFields`. `fields` is now optional (was
a required non-empty tuple) — an index must declare at least one of
`fields`, `coveringFields`, or `keySystemColumns`.

This closes a real gap: a covering index can only serve a query's join
index-only (avoiding a heap fetch per candidate row) if the index's key
matches the join's actual predicate. Queries that join on a system column
directly (e.g. TypeGraph's compiled `n.id = e.from_id` for a reverse
traversal) had no way to declare a matching index, since `fields`/
`coveringFields` only ever accept the node's own schema properties.
`keySystemColumns: ["id"]` (plus `coveringFields` for whatever the query
also projects) now lets that same join be served index-only.

Rejects edge-only system columns (`from_kind`/`from_id`/`to_kind`/
`to_id`) on a node index, and rejects any column already implied by
`scope`. Not supported with `method: "gin" | "trigram"` (same restriction
as `coveringFields`). Canonicalized by absence, like `method`: indexes
that don't use it produce byte-identical names/hashes to before this
field existed, so existing stored schema documents and materialization
signatures are unaffected.
