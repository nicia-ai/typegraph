---
"@nicia-ai/typegraph": patch
---

Subgraph extraction on PostgreSQL now runs the recursive traversal once
instead of twice. The node and edge fetches previously each embedded the
full recursive CTE; the closure ids are now fetched in one statement and
passed to both fetches as a single `text[]` parameter, filtered via an
`EXISTS` semi-join over `unnest`. Those id-filtered fetches execute as
unnamed statements so PostgreSQL plans them against the actual array on
every call — a named prepared statement flips to a generic plan after
five executions, which mis-plans array-cardinality-dependent filters
(measured 21ms → 310ms on the edge fetch). Depth-3 stress subgraph
(1,109 nodes / 4,513 edges, wide payloads): 82.9ms → 30.9ms full
hydration, 72.3ms → 15.6ms with SQL projection. SQLite keeps its
existing single-statement-per-fetch form, which is already optimal for
an in-process engine.
