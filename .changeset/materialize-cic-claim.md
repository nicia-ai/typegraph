---
"@nicia-ai/typegraph": minor
---

fix: `materializeIndexes` serializes same-index builds across callers on PostgreSQL via a durable claim in the status table (two concurrent same-name expression-index `CREATE INDEX CONCURRENTLY` builds can deadlock — no safe-snapshot exemption). Losers wait and converge as `alreadyMaterialized`; a crashed builder's claim expires after a 15-minute lease and the takeover drops the INVALID index leftover before rebuilding (relational indexes now self-heal instead of requiring manual repair). With same-index builds serialized, the automatic post-create `ANALYZE` is re-enabled on PostgreSQL.
