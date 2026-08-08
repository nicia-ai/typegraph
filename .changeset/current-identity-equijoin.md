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

Each traversal step now widens its frontier onto the closure's class members with
an outer join, so the candidate edge is reached by the same ordinary indexed
equality a traversal without identity expansion uses. One compiler path serves
both coordinates and both emitters. On SQLite a hop over 100,000 matching edges
from a 500-row frontier drops from 51.6 s to 77 ms, and `EXPLAIN QUERY PLAN`
seeks `typegraph_edges_from_idx` where it used to scan every matching edge per
source row; PostgreSQL drops from 9.2 s to 61 ms.

A traversal at a **historical** coordinate reaches its candidate edge through the
same step, so it gains the same join order: on SQLite an `asOf` hop over 100,000
matching edges drops from 31.3 s to 241 ms. That coordinate's own remaining cost
is the ledger reconstruction, still tracked in typegraph#310.

Results are unchanged at every coordinate: physical edges stay deduplicated, and
member visibility, the `sameIdAcrossKinds` profile and the read instant are all
resolved exactly where they were. The class members a current-coordinate step
joins are reached by seeking the closure from the frontier row, so the cost of
the widening tracks the frontier and its classes rather than the identity
population — see the follow-up changeset, which replaced the graph-wide relation
this change first shipped with that seek.
