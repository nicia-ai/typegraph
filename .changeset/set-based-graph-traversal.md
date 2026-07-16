---
"@nicia-ai/typegraph": patch
---

Replace path-enumerating recursive CTEs in `reachable`, `neighbors`,
`shortestPath`, and `canReach` with set-based breadth-first search.

Transactional SQLite and PostgreSQL backends now execute graph iterations
against a connection-local temporary working table, de-duplicated by node kind
and ID on every round. Non-transactional backends retain parity through a
bind-limit-aware inline frontier. Traversals run in one snapshot where the
backend supports transactions, preserve temporal filtering, and clean up
temporary state on success or failure.
