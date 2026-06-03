---
"@nicia-ai/typegraph": minor
---

Support the full query feature set inside SQLite set operations
(`UNION`/`UNION ALL`/`INTERSECT`/`EXCEPT`).

Previously the SQLite set-operation compiler hand-rolled a thin subset of leaf
compilation and rejected leaves that used traversals, `EXISTS`/`IN` subqueries,
vector or fulltext predicates, `GROUP BY`/`HAVING`, or per-leaf
`ORDER BY`/`LIMIT`/`OFFSET` — throwing `UnsupportedPredicateError` at execution
time. PostgreSQL accepted all of these. The result was a portability cliff: a
combined query developed against PostgreSQL could throw the moment the backend
was switched to SQLite.

Both dialects now compile every leaf with the full query compiler and only
differ in how each operand is wrapped. SQLite forbids parenthesized compound
operands, but it does allow a `WITH` clause inside a FROM-subquery, so each
operand is emitted as `SELECT * FROM (<leaf>)`. This keeps every leaf's CTEs
(traversal joins, recursive expansions, vector/fulltext relevance) scoped to its
own subquery and lets per-leaf `ORDER BY`/`LIMIT`/`OFFSET` live inside the wrap.
Nested set operations are wrapped the same way, preserving the AST's grouping
regardless of the dialect's native compound-operator associativity. As a
side effect, vector/fulltext predicates in set-operation leaves now use the
backend's configured relevance strategy instead of falling back to the dialect
default.

Note: `GROUP BY`/`HAVING` leaves are supported at the compiler level, but the
query builder still does not expose `.union()`/`.intersect()`/`.except()` on
aggregate queries — that builder gate is unchanged and applies equally to both
backends.
