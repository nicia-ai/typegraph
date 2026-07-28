---
"@nicia-ai/typegraph": patch
---

Fence deferred kind cleanup against concurrent schema re-adds. Removal now
rechecks the active schema and atomically deletes live rows, recorded-time
intervals, vector storage, and contribution markers under the schema lock.
Custom backends that implement the optional `schemaWriteTransaction` capability
must expose transaction-bound statement execution, table-existence probing,
schema DDL, and vector-contribution marker deletion on its callback target.
