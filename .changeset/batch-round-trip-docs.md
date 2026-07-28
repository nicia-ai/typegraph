---
"@nicia-ai/typegraph": patch
---

State `store.batch()`'s real cost where callers see it. `batch()` runs its
queries in sequence, keeping at most one in flight — at least one statement
each, and two for a query whose selective-field mapping falls back after its
statement has already executed. So it caps concurrency at best and will not fix
an N+1. It is also not a snapshot: PostgreSQL's default read-committed isolation
lets a later query in the batch observe a commit the earlier ones did not, and
there is no public way to get one across fluent queries, since a transaction
context exposes no query builder.

The docstrings for `batch()`, `BatchableQuery`, `executeOn`, and the edge
`batchFind*` methods now lead with that, and point at the set-oriented and
chunked alternatives, described by what they actually do: `.traverse()` compiles
a chain to one statement, `store.subgraph()` costs 2 statements on SQLite and 3
on PostgreSQL, `getByIds()` issues one statement per bind-limit chunk (falling
back to concurrent per-id lookups where the backend exposes no batch read), and
`bulkFindByIndex()` costs a probe plus that same chunked hydration.

The docs site is corrected to match, including claims that `batch()` "minimizes
round-trips for reads", that `batchFind*` collapses N reads into "a single
transactional round-trip", that `subgraph()` is a single statement, and that
`getByIds()` is a single query. Transaction support no longer implies a
transport shape anywhere: Durable Objects use an ambient transaction with no
framing statements, and the non-transactional path may still reuse one client.
The changelog entry that shipped `batch()` carries a correction note rather than
a silent rewrite.

Execution semantics are unchanged. One public diagnostic changes: the
`ConfigurationError` message for a batch endpoint read on a read-only
`StoreView` no longer calls `batch()` a "batch loader".
