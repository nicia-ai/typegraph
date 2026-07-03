---
"@nicia-ai/typegraph": minor
---

SQLite CRUD statements now reuse the prepared-statement cache. The
operation backend's read/write helpers previously executed through
drizzle's `db.all()` / `db.run()`, which re-prepares every statement on
every call — only the query engine's `backend.execute` path used the
prepared-statement LRU. On synchronous drivers (better-sqlite3,
bun:sqlite) CRUD statements and the per-write transaction frames
(`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`) now route through the
execution adapter's compiled path, so a repeated operation shape re-binds
parameters against a cached prepared statement. A warmed CRUD cycle
re-prepares nothing. Async drivers (remote libsql/Turso, D1) have no
statement cache and keep the existing execution path.

Measured on the write bench (in-memory SQLite, order-controlled A/B):
single-op creates ~18.3k → ~28.8k ops/s (~1.6×), transaction-batched
creates ~23.9k → ~36k ops/s (~1.5×).
