---
"@nicia-ai/typegraph": patch
---

`updateWhere()` no longer writes a row that a concurrent transaction changed after the candidate selection read it. The candidate query selected ids against the statement's snapshot, and the outer `UPDATE` matched rows by id alone. Under PostgreSQL `READ COMMITTED`, a row another session changed and committed while the update waited for its lock was re-checked only against the graph, kind and live-row conditions, so the patch landed even when the committed row no longer satisfied `where`, `exists` or `candidates` — for a property predicate as much as a `$meta.version` one. The write now pairs each candidate id with the version the snapshot selected, so a row changed since then is skipped and absent from `affectedCount`. SQLite, which serializes writers, was not affected. `compareAndSet()` is unchanged: it selects by id and its `expected` values were already re-checked on the target row.
