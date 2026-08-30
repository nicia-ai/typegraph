---
"@nicia-ai/typegraph": minor
---

Execute eligible mixed node and edge `bulkUpsertById()` mutation sets through atomic programs bound to the exact collection-opened, caller-supplied, or adopted PostgreSQL transaction. The operation now returns an explicit `applied | unsupported` verdict, where `unsupported` is emitted before program SQL and safely re-enters the complete portable path. Transaction-session programs use a savepoint so typed refusal diagnosis remains available without committing or poisoning the caller's surrounding transaction.
