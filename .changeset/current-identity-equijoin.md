---
"@nicia-ai/typegraph": patch
---

Reach the candidate edge of a current-coordinate identity-expanded traversal by
an equi-join instead of a correlated membership scan

An identity-expanded hop at the current coordinate read the materialized closure
from inside a correlated `EXISTS`, so nothing in the join condition linked the
frontier row to the edge row. Both engines were free to enumerate
*frontier rows × edges of the matching kind* and probe the closure per pair, which
cost quadratically in graph size.

The closure is now projected once per statement into the same
`(seed_kind, seed_id, kind, id)` relation a historical read already builds from
the assertion ledger — a self-join on the class label, filtered to members visible
now — and each traversal step joins it, so the candidate edge is reached by the
same ordinary indexed equality a traversal without identity expansion uses. One
compiler path serves both coordinates and both emitters. On SQLite a hop over
100,000 matching edges from a 500-row frontier drops from 51.6 s to 77 ms, and
`EXPLAIN QUERY PLAN` seeks `typegraph_edges_from_idx` where it used to scan every
matching edge per source row; PostgreSQL drops from 9.2 s to 61 ms.

Results are unchanged at every coordinate: physical edges stay deduplicated, and
member visibility, the `sameIdAcrossKinds` profile and the read instant are all
resolved exactly where they were. The relation covers the whole identity
population rather than just the frontier, so a hop from a single start row now
pays one pass over that population instead of one pass over the candidate edges —
the cost model in the identity guide states the tradeoff.
