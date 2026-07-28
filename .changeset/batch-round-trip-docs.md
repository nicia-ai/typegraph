---
"@nicia-ai/typegraph": patch
---

State `store.batch()`'s real cost where callers see it. `batch()` runs its
queries in sequence — N query executions, one statement each, never one round
trip — so it collapses connection acquisition at best and will not fix an N+1.
It is also not a snapshot: PostgreSQL's default read-committed isolation lets a
later query in the batch observe a commit the earlier ones did not.

The docstrings for `batch()`, `BatchableQuery`, `executeOn`, and the edge
`batchFind*` methods now lead with that, and point at the set-oriented and
chunked alternatives, described by what they actually do: `.traverse()` compiles
a chain to one statement, `store.subgraph()` costs 2 statements on SQLite and 3
on PostgreSQL, `getByIds()` issues one statement per bind-limit chunk (falling
back to one per distinct id where the backend exposes no batch read), and
`bulkFindByIndex()` costs a probe plus that same chunked hydration.

The docs site is corrected to match, including claims that `batch()` "minimizes
round-trips for reads", that `batchFind*` collapses N reads into "a single
transactional round-trip", and that `subgraph()` is a single statement. The
changelog entry that shipped `batch()` carries a correction note rather than a
silent rewrite.

Behavior is unchanged.
