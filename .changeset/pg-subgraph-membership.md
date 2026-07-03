---
"@nicia-ai/typegraph": patch
---

Subgraph extraction is ~4× faster on PostgreSQL. The final node/edge
fetches filtered ids with `IN (SELECT id FROM included_ids)`; PostgreSQL
pulls that form up into a join whose recursive-CTE row estimate (~10 rows
for a single-row seed) drives the planner into a nested-loop join filter —
measured at ~10 million discarded rows on the depth-3 benchmark shape. CTE
membership now goes through a dialect seam: PostgreSQL emits
`= ANY(ARRAY(subquery))`, which collapses the CTE once via an InitPlan and
is hash-probed and index-condition eligible; SQLite keeps `IN (subquery)`,
which it already evaluates optimally.

Measured (benchmark suite, 1,200 users / depth-3 stress shape): PostgreSQL
subgraph full hydration 322ms → 82ms, depth-2 11.5ms → 7.1ms; SQLite
unchanged.
