---
"@nicia-ai/typegraph": minor
---

Add exact `store.algorithms.weaklyConnectedComponents()` for transactional
SQLite and PostgreSQL backends. Results include deterministic component
representatives and sizes, honor valid/recorded temporal views, and fail with a
typed convergence error instead of returning partial labels when the configured
iteration budget is exhausted.

PostgreSQL iterative operations now refresh temporary-table planner statistics
after sufficiently large seeds and multiplicative growth, avoiding plans based
on the engine's initial one-row estimate. The policy also covers growing BFS
working tables and is a no-op on SQLite.
