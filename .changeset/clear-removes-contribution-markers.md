---
"@nicia-ai/typegraph": patch
---

`store.clear()` now deletes the graph's durable contribution-materialization markers along with every other graph-scoped row. A cleared graph no longer leaves graph-local marker rows (full markers for graph-scoped contributions and activation markers for deployment-scoped ones) behind on SQLite or PostgreSQL; deployment-scoped physical markers are preserved because they attest shared storage the per-graph delete never touches, and the next privileged boot re-records the graph-local rows from them. On backends with interactive transactions, the delete runs in the same transaction as the rest of `clearGraph`; it also tolerates the marker table's absence on databases that never materialized a contribution.
