---
"@nicia-ai/typegraph": patch
---

Ensure the kind-removal status table before `evolve()` checks it, so databases
created before TypeGraph 0.44 can evolve without manual backend initialization.
Concurrent PostgreSQL focused-table ensures also retry the catalog uniqueness
race that `CREATE TABLE IF NOT EXISTS` can surface during replica startup.
