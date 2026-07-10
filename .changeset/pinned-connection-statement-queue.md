---
"@nicia-ai/typegraph": patch
---

Fix: serialize the statements TypeGraph issues on a transaction's pinned
Postgres connection, so its own graph writes never present two queries to one
connection at once.

A transaction pins one connection, and the PostgreSQL wire protocol carries one
statement at a time. node-postgres hid that behind an internal queue, deprecated
it in `pg@8.22` ("Calling client.query() when the client is already executing a
query is deprecated and will be removed in pg@9.0. Use async/await or an
external async flow control mechanism instead"), and removes the queue in
`pg@9`. TypeGraph overlapped statements on a pinned connection in two ways:

- **Always on, no user concurrency required.** The node write pipeline issues
  `Promise.all([syncEmbeddings, syncFulltext])` for any schema that has both a
  `searchable()` field and an `embedding()` field, so every single `create()`,
  `update()`, or resurrect on such a schema put two statements on the wire.
- **User-driven.** `store.transaction(async (tx) => { await Promise.all([...]) })`
  is a documented, recommended pattern.

Transaction-scoped backends now run every statement they issue through a
per-connection queue. Concurrency at the API surface is unchanged — a
`Promise.all` of graph writes still works, and on a pooled (non-transactional)
backend the statements still run genuinely concurrently. The queue serializes
only what already had to be serial. A multi-statement `SET LOCAL`-scoped vector
search (snapshot / set / select / restore) runs as one exclusive group, so two
concurrent searches can no longer interleave and apply each other's `efSearch`.

The transaction boundary also **drains and closes** the queue before the driver
emits `COMMIT` / `ROLLBACK`. Those control statements do not travel through the
queue, so without the drain a rollback could overlap a live statement. And a
callback that rejects out of a `Promise.all` leaves its siblings running: their
statements would otherwise land on the connection *after* the pool had reclaimed
it, executing inside an unrelated transaction. Such a statement is now refused
with a new `TransactionClosedError` (normally invisible — `Promise.all` has
already rejected with the original failure and discards this one).

**Scope: the queue mediates only TypeGraph's own statements.** The raw Drizzle
handle exposed as `tx.sql` (for writing your own relational tables in the same
atomic boundary) bypasses it. Running a raw statement concurrently with a graph
write — or with another raw statement — still races on the one pinned
connection, and `drainAndClose` cannot wait for a raw statement it never saw.
Await each `tx.sql` statement before the next write; this is inherent to a
single-connection transaction, not something TypeGraph can enforce over a handle
it doesn't mediate. `adoptTransaction()` likewise serializes the statements it
issues but never closes the queue — the caller owns that transaction's end.
