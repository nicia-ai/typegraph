---
"@nicia-ai/typegraph": minor
---

Reduce `BackendCapabilities` to the flags the library actually consumes:
`transactions`, `vector`, and `fulltext`.

The descriptive-only flags `jsonb`, `ginIndexes`, `partialIndexes`, `cte`, and
`returning` were never read anywhere to gate a query feature or pick an index
strategy. `jsonb`/`ginIndexes` additionally misrepresented SQLite, which has
native JSON (`json_extract`/`json_each`) and supports B-tree expression indexes
on scalar JSON properties at parity with PostgreSQL — the only real JSON
difference (GIN containment acceleration) is a Postgres performance
characteristic, not a gated capability.

If you were reading any of these removed flags, branch on
`backend.dialect === "postgres"` instead, or rely on the dialect layer
(JSON-path predicates, `WITH` queries, `RETURNING`, partial indexes, and
`defineNodeIndex`/`defineEdgeIndex` work the same on both backends).
