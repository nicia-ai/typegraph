---
"@nicia-ai/typegraph": minor
---

Add history-preserving PostgreSQL graph namespace forks, store-free graph-extension introspection, recorded fork points for incremental merge, and bounded change enumeration for revision-tracked stores. Linear traversal queries now read their final hop directly. Caller-owned PostgreSQL transactions use `createPostgresTransactionBackend()` to serialize statements on their pinned connection; transaction marker checks read that same connection.
