---
"@nicia-ai/typegraph": minor
---

Add `transactionMode` to SQLite execution profile, fixing Cloudflare Durable Object compatibility.

`createSqliteBackend` previously used raw `BEGIN`/`COMMIT`/`ROLLBACK` SQL for all sync SQLite drivers. This crashes on Cloudflare Durable Object SQLite (via `drizzle-orm/durable-sqlite`) because the driver does not support raw transaction SQL through `db.run()`.

The new `transactionMode` option (`"sql"` | `"drizzle"` | `"none"`) controls how transactions are managed:

- `"sql"` — TypeGraph issues `BEGIN`/`COMMIT`/`ROLLBACK` directly (default for better-sqlite3, bun:sqlite)
- `"drizzle"` — delegates to Drizzle's `db.transaction()` (default for async drivers)
- `"none"` — transactions disabled (default for D1 and Durable Objects)

D1 and Durable Object sessions are auto-detected by Drizzle session name. Users can override via `executionProfile: { transactionMode: "..." }`.

**Breaking:** `isD1` removed from `SqliteExecutionProfileHints` and `SqliteExecutionProfile`. Use `transactionMode: "none"` instead. `D1_CAPABILITIES` removed — capabilities are now derived from `transactionMode`.
