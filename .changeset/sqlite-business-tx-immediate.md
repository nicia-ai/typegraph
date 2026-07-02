---
"@nicia-ai/typegraph": patch
---

Open SQLite business-write transactions with `BEGIN IMMEDIATE` on the sync
(better-sqlite3) path, matching schema writes and the async libsql/Drizzle path.
A deferred `BEGIN` acquired the reserved write lock only on the first write, so a
read-then-write inside a transaction could fail with "database is locked" against
a writer on another connection to the same file; taking the lock at the start of
the transaction lets SQLite's busy timeout wait for it instead. The per-backend
serialized write queue continues to order a single backend's own transactions.
