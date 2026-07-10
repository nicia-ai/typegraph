---
"@nicia-ai/typegraph": patch
---

Fix: "current" temporal reads now evaluate validity against the application
clock, not the database clock — repairing a read-after-write consistency
violation on Postgres.

`valid_from` is stamped from the application clock (`Date.toISOString()`) on
write, but a "current" read compiled its validity filter against the database
clock (`valid_from <= NOW()` on Postgres). On any deployment where the
application-server clock runs ahead of the database-server clock — i.e. the
app and database on separate hosts, which is the norm — a freshly-created node
or edge could be missing from the very "current" read that immediately
followed its creation, until the database clock caught up. SQLite (a single
in-process clock) was never exposed.

The "current" read now binds the application clock (`nowIso()`) as a
parameter — the same clock `valid_from`, the facade search-currency filter,
and the recorded/logical clock already use — across every current-read path
(standard and recursive queries, subgraph extraction, graph algorithms, and
recorded-time reads). The temporal-visibility clock is now a single source.
Because the current-read instant is no longer dialect-specific, the internal
`DialectAdapter.currentTimestamp()` seam has been removed.

**Know the consistency model this buys you.** Reads and writes now share one
clock — *the clock of the process that issued them*. Read-after-write
consistency therefore holds **per application process**: a node you just
created is visible to the very next current read from that same process,
which is the guarantee the bug broke. It does **not** extend across processes.
Two application servers with skewed clocks, writing to one PostgreSQL
database, can still miss each other's fresh rows: a row stamped
`valid_from = T` by the server that runs ahead stays invisible to a current
read from the server that runs behind until its own clock passes `T`. The
window equals the skew between the two application hosts, not between an
application host and the database. If you need cross-process read-after-write
consistency, keep application clocks disciplined (NTP), or read at an explicit
`asOf` coordinate rather than `current`.
