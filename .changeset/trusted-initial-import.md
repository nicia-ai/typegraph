---
"@nicia-ai/typegraph": minor
---

Add `trustedImportGraph` and `trustedImportGraphStream` for atomic initial loads
into a fresh, dedicated database. The distinct trusted surface bypasses schema,
reference, cardinality, and conflict validation; uses prepared SQLite writes or
PostgreSQL `UNNEST` ingestion; defers rebuildable secondary indexes; refreshes
planner statistics; and rolls the complete stream back on any failure.

The first version rejects non-empty TypeGraph data tables, recorded history,
revision tracking, uniqueness constraints, searchable fields, vector fields,
and backends without the required native transactional path.
