---
"@nicia-ai/typegraph": patch
---

Fence schema-version commits against concurrent schema-managed Store writes.
SQLite uses its immediate writer transaction; PostgreSQL locks the active schema
row in shared mode for managed writes and exclusive mode for schema commits.
Managed writes revalidate their Store schema version while holding the fence, so
stale queued writes fail instead of landing against a schema that no longer
accepts them. Snapshot-isolated PostgreSQL transactions may raise the database's
native serialization failure; callers retry the whole transaction, and graph
merge does so automatically. Schema-managed Stores on non-transactional or
custom backends without the fence now fail closed on writes. Raw `createStore()`
instances, direct backend writes, and Stores whose schema metadata was reset by
`clear()` remain outside the versioned guarantee.
