---
"@nicia-ai/typegraph": minor
---

Tolerate the concurrent `CREATE EXTENSION` race when materializing trigram indexes.

`method: "trigram"` needs `pg_trgm`, the extension is database-global, and the claim that serializes an index build is keyed per index — so two materializers building different trigram indexes both reach `CREATE EXTENSION IF NOT EXISTS pg_trgm`. That statement is not a concurrency primitive on PostgreSQL: its existence check cannot see another session's uncommitted `pg_extension` row, so the loser waited for the winner and was handed SQLSTATE 23505 instead of a notice, reporting `failed` for an extension the winner had already installed.

`GraphBackend` gains an optional `ensureExtension(name)` member — the single owner of "install a database-global extension idempotently" — which the bundled PostgreSQL backend implements through the same concurrent-DDL retry its table and column creates already use. The name is validated against the exported `DATABASE_EXTENSION_NAMES` allowlist rather than interpolated freely. A backend that does not implement the member keeps issuing the bare statement, so a third-party trigram index is still materialized, just without race tolerance.

Closes #446.
