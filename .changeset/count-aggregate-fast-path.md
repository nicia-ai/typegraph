---
"@nicia-ai/typegraph": patch
---

Push `LIMIT` past `GROUP BY` in the count aggregate fast path when it's safe.

When `groupByNode(...).aggregate({ x: count(alias) })` is paired with an optional traversal and a `.limit(n)` that doesn't depend on the aggregate (no `ORDER BY`, or an `ORDER BY` restricted to group keys), the compiler now emits the `LIMIT` inside the start CTE. The `GROUP BY` runs over `n` rows instead of the full start set — `O(limit)` grouping work instead of `O(|start|)`. When `OFFSET` is also set, it rides along with the `LIMIT` into the start CTE and the outer `SELECT` drops its own `LIMIT`/`OFFSET` so neither clause is double-applied.

The fast path also picks `INNER JOIN` over `LEFT JOIN` for the target-node join whenever a `whereNode()` predicate applies to the target alias, so those predicates constrain every aggregate — including `countEdges(...)`. `LEFT JOIN` remains the strategy when only temporal/delete filters apply to the target, so `countEdges` and `count(target)` can coexist in one query with divergent semantics.

No change to query semantics — aggregate counts still reflect the same `count(target)` as before, including the target node's temporal and deletion filters. No change to aggregate queries without a `LIMIT`. No change on SQLite or PostgreSQL query shapes outside the fast path.

Measured impact: scopes down group-by work for "top-N by count"-style aggregate queries. No impact on the blog-post benchmark's full-graph aggregate (which measures the ungrouped 1,200-user case and intentionally runs without a `LIMIT`).
