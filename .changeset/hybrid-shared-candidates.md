---
"@nicia-ai/typegraph": patch
---

The single-statement hybrid search now emits the candidates set
(liveness/currency filter, or the compiled `where` predicate query)
once, as a CTE shared by the vector and fulltext legs, instead of
embedding — and re-executing — a private copy inside each leg. The
duplicate evaluation was most expensive with a `where` filter, whose
compiled candidates query ran twice per search: measured on PostgreSQL,
filtered hybrid drops 26.5ms → 17.1ms at 5k docs (bench shape
11.8ms → 8.6ms; unfiltered 6.1ms → 4.9ms). This also removes a subtle
inconsistency where each leg stamped its own currency instant. SQLite
is unchanged within noise (in-process re-execution was cheap).
