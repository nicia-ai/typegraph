---
"@nicia-ai/typegraph": patch
---

Fix `ORDER BY`/`LIMIT`/`OFFSET` being silently dropped on a nested set-operation
operand.

When a set operation was nested inside another — e.g.
`a.union(b).limit(10).intersect(c)` — the inner compound's suffix clauses were
applied only at the top level, so the inner `limit`/`offset` were ignored and
the outer operation ran over the full (unlimited) inner result. The compiler now
emits each nested compound's own `ORDER BY`/`LIMIT`/`OFFSET` inside its operand
subquery on both SQLite and PostgreSQL.
