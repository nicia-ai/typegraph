---
"@nicia-ai/typegraph": patch
---

State `store.batch()`'s real cost where callers see it. `batch()` runs its
queries in sequence — N query executions, one statement each, never one round
trip — so it collapses connection acquisition at best and will not fix an N+1.
It is also not a snapshot: PostgreSQL's default read-committed isolation lets a
later query in the batch observe a commit the earlier ones did not.

The docstrings for `batch()`, `BatchableQuery`, `executeOn`, and the edge
`batchFind*` methods now lead with that, and point at the alternatives whose
cost is independent of N, described by what they actually do: `.traverse()`
compiles a chain to one statement, `store.subgraph()` costs a fixed 2 statements
on SQLite and 3 on PostgreSQL, `bulkFindByIndex()` costs a probe plus a
hydration read, and `getByIds()` costs one statement where the backend exposes a
batch read. The docs site is corrected to match, including claims that `batch()`
"minimizes round-trips for reads", that `batchFind*` collapses N reads into "a
single transactional round-trip", and that `subgraph()` is a single statement.

Behavior is unchanged.
