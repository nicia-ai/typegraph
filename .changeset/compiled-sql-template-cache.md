---
"@nicia-ai/typegraph": patch
---

Perf: cache compiled query SQL across executions again, without freezing the
read instant.

The read-freshness fix recompiled a query's full AST to SQL on every
`execute()` so a reused or prepared query would always see the latest rows.
That kept results fresh but made the recommended `.prepare()`-once-`.execute()`-
many pattern pay a full compile per call (a point lookup ~58µs, a three-hop
traversal ~450µs of pure JS compilation).

Only the bound "current" read instant varies between two compilations of the
same query; the SQL text is identical. So a query now compiles once into a
cached statement whose read instant is a reserved execution-time placeholder,
and each execution fills a fresh instant into it and runs the cached text
directly. Repeated point-query execution drops from ~47µs to ~2.4µs (near the
raw-execution floor) while staying just as fresh — a row created after
`prepare()` or the first `execute()` is still visible on the next call.

The cache applies to `ExecutableQuery`, prepared queries, aggregate queries,
and set operations, on backends that can compile and run raw SQL text
(synchronous SQLite and PostgreSQL backends); other backends — including async
SQLite profiles that do not expose `executeRaw` — fall back to per-call
recompilation unchanged. Statements whose execution depends on the compiled
SQL object — pgvector approximate-scan GUC tuning and parameter-blind-plan
avoidance — keep running through the standard execution path. `param()` now
rejects the reserved read-instant name, and aggregate queries (which have no
`.prepare()`) reject `param()` with clear guidance instead of a downstream
binding error.
