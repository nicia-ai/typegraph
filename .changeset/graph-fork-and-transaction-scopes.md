---
"@nicia-ai/typegraph": minor
---

Add history-preserving PostgreSQL graph namespace forks, store-free graph-extension introspection, recorded fork points for incremental merge, and bounded change enumeration for revision-tracked stores. Linear traversal queries now read their final hop directly. Caller-owned PostgreSQL transactions use `createPostgresTransactionBackend()` to serialize statements on their pinned connection; transaction marker checks read that same connection.

Custom engine profiles need revision-change table DDL for base-schema version 4 adoption and trigger DDL to enable the change journal. Missing dependencies raise `ConfigurationError` when those operations are requested.
