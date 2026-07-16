---
"@nicia-ai/typegraph": minor
---

Add exact `store.algorithms.weaklyConnectedComponents()` for transactional
SQLite and PostgreSQL backends. Results include deterministic component
representatives and sizes, honor valid/recorded temporal views, and fail with a
typed convergence error instead of returning partial labels when the configured
iteration budget is exhausted.
