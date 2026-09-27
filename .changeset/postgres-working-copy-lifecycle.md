---
"@nicia-ai/typegraph": minor
---

Add a PostgreSQL table-backed working-copy manager for graphs using bundled table and tsvector storage. It owns ephemeral and durable allocation, a persistent recovery ledger, origin-attested reopen and destroy, graph-scoped SQL cloning under source locks, and bounded orphan inventory. The strategy refuses vector storage, graph-declared indexes, and custom fulltext strategies until their physical names can be isolated within one database; host-level database forks remain available for those graphs.
