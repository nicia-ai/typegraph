---
"@nicia-ai/typegraph": patch
---

**`store.subgraph()` now fires `onQueryStart` / `onQueryEnd` / `onError` for every statement it submits**, at the current coordinate and under `store.asOfRecorded(...)`, as the Observability Hooks guide documented. Direct subgraph reads previously ran on the store's unobserved backend, so a hook saw nothing while `tx.subgraph()`, `batchOnce()` subgraphs, neighbor reads and fluent queries were observed. A direct subgraph emits two statements on SQLite and three on PostgreSQL, and a `composition` subgraph emits five on both.
