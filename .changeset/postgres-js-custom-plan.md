---
"@nicia-ai/typegraph": patch
---

Statements whose good plan depends on their parameter values (the
subgraph id-array fetches, marked internally with the custom-plan
brand) now opt out of statement preparation per call on the postgres-js
driver too, via `sql.unsafe(text, params, { prepare: false })`.
Previously postgres-js prepared them like everything else, so after
five executions PostgreSQL flipped them to a generic, parameter-blind
plan — the same cliff fixed for node-postgres in the subgraph
shared-traversal change (measured there: 21ms → 310ms on the edge
fetch). Scalar-parameter statements keep the driver's prepared default.
