---
"@nicia-ai/typegraph": patch
---

Bound current-coordinate identity expansion by the frontier instead of the
identity population

An identity-expanded traversal at the current coordinate built its class relation
by self-joining the whole identity closure into a materialized CTE, before any
frontier predicate applied. The relation's size is the sum of the squares of
every class in the graph, so a hop from a single start row paid for identity
classes it never touched: nine unrelated classes of 501 members materialize
2,259,009 seed/member pairs, and the hop measured 564 ms on SQLite and 568 ms on
PostgreSQL where the equivalent traversal without expansion costs microseconds.
Doubling an unrelated class quadrupled the cost.

Each step now seeks the closure from its own frontier rows — the frontier row's
class through the closure primary key, that class's members through the class
index, each member's node for its visibility — so the peer relation is never
built for classes the query does not touch. The same hop measures 0.5 ms on
SQLite and 2.4 ms on PostgreSQL, and PostgreSQL's `EXPLAIN (ANALYZE)` reports 18
rows visited against 4,522,557. A single-start-row hop over 50,000 folded triples
drops from 387 ms to 1 ms on SQLite. Wide-frontier hops are unchanged: 500 source
rows over 100,000 matching edges measures 325 ms against 331 ms, because that
shape was already paying for a population it used.

The **historical** coordinate keeps its hoisted, materialized relation. Its rows
come from a recursive fixed point over the assertion ledger that no frontier row
narrows, so evaluating it once per statement is still the win, and the two
coordinates are now deliberately different strategies behind one interface rather
than one relation with two sources. Both remain a single compilation path across
dialects.

Results are unchanged at both coordinates: physical edges stay deduplicated,
member visibility is still resolved against the read instant, and a frontier row
in no class still expands to itself.
