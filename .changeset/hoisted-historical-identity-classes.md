---
"@nicia-ai/typegraph": patch
---

Evaluate the historical identity-class reconstruction once per query instead of
once per candidate edge

An identity-expanded traversal hop under a historical coordinate (`asOf`,
`asOfRecorded`, or a non-current `view()`) has no materialized closure to read,
so it rebuilds classes from the assertion ledger. That rebuild used to sit inside
the correlated edge predicate, where SQLite re-materialized it for every
candidate *(source row, edge)* pair, and under `sameIdAcrossKinds: "fold"` each
rebuild also scanned the structural same-id relation across the graph — a
quadratic term that quadrupled per doubling of graph size.

The reconstruction is now a single materialized query-level relation of
`(seed_kind, seed_id, kind, id)` rows, seeded by the nodes that have identity
peers rather than by the frontier, so it depends on nothing a traversal step
carries and is built once for the whole statement. Each step widens its frontier
onto that relation with an outer join, which turns the candidate-edge lookup into
the same ordinary indexed equality a traversal without identity expansion uses.
On the narrow-edge fixture (SQLite, all *n* nodes acting as source rows) the hop
drops from 122/486/1984/8261 ms at *n* = 250/500/1000/2000 to 7/7/14/28 ms, and
grows linearly rather than quadratically.

Results are unchanged at every coordinate. Current-coordinate traversal still
reads the materialized closure through its existing correlated predicate.
