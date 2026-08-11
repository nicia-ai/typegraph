---
"@nicia-ai/typegraph": minor
---

Tolerate the concurrent `CREATE EXTENSION` race when materializing trigram indexes, and give every extension install one owner.

`method: "trigram"` needs `pg_trgm`, the extension is database-global, and the claim that serializes an index build is keyed per index — so two materializers building different trigram indexes both reach `CREATE EXTENSION IF NOT EXISTS pg_trgm`. That statement is not a concurrency primitive on PostgreSQL: its existence check cannot see another session's uncommitted `pg_extension` row, so the loser waited for the winner and was handed SQLSTATE 23505 instead of a notice, reporting `failed` for an extension the winner had already installed.

`GraphBackend` gains an optional `ensureExtension(name)` member — the single owner of "install a database-global extension idempotently" — which the bundled PostgreSQL backend implements with both fences: a transaction advisory lock keyed on the extension, so same-key installers never raise at all, and the concurrent-DDL retry its table and column creates already use, which clears the 23505 an installer that did NOT take that lock can still hand it (a peer on an older version, or a `capabilities.transactions: false` backend with no transaction to hang the lock on). The name is validated against the exported `DATABASE_EXTENSION_NAMES` allowlist rather than interpolated freely.

`GraphBackend.ensureTrigramExtension`, the `pg_trgm`-only member added in 0.47, is deprecated in favour of `ensureExtension` and now says exactly the same thing: the bundled PostgreSQL backend implements it by delegating, and index materialization consults it only after `ensureExtension`, so a backend written against 0.47 keeps its fence unchanged. A backend implementing neither keeps issuing the bare statement with materialization's own one-shot retry, so a third-party trigram index is still materialized. The advisory-lock key changed from `typegraph:pg-trgm-ddl` to `typegraph:extension-ddl:<extension>` when the fence generalized to any allowlisted extension — a 0.47 peer therefore takes a different key, which is exactly why the retry is retained on the locked path too.

Closes #446.
