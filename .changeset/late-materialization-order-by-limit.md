---
"@nicia-ai/typegraph": patch
---

Selective `ORDER BY … LIMIT` queries now compile with late materialization:
the query sorts and limits a lean candidate set carrying only identity, sort
keys, and predicate columns, then re-fetches the deferred projection columns
by primary key for only the surviving rows — instead of extracting every
projected column for every candidate and discarding all but the `LIMIT`
survivors after the sort. At LDBC SNB SF1, IC9's top-20 over a 1.18M-comment
fan-out stops extracting `content` 1.18M times, ~30–37% faster on SQLite.

The transform fires only on the selective `.select()` path with `ORDER BY`
and a positive `LIMIT` at the live coordinate. Aggregates, vector/fulltext,
optional (LEFT JOIN) traversals, edge-field projections, non-selective
queries, and recorded-time reads keep the flat plan unchanged.
