---
"@nicia-ai/typegraph": minor
---

Default-path performance tuning for SQLite and bulk maintenance verbs.

- `createLocalSqliteBackend` now applies connection pragmas at open:
  `journal_mode=WAL`, `synchronous=NORMAL`, and a 5s `busy_timeout`. On
  file-backed databases this makes single-operation writes roughly 5×
  faster than the better-sqlite3 driver defaults (rollback journal,
  `synchronous=FULL`), because each write no longer pays a full-durability
  fsync in journal mode. Override individual values via the new `pragmas`
  option, or pass `pragmas: false` to keep driver defaults.
- The SQLite backend now detects the connection's real bound-parameter
  budget instead of assuming the historic 999: better-sqlite3 compiles in
  `SQLITE_MAX_VARIABLE_NUMBER=32766` (probed via `PRAGMA compile_options`,
  with a `sqlite_version() >= 3.32` fallback), Cloudflare D1 is capped at
  its documented 100, and undetectable async drivers keep the conservative
  999 floor. Batch chunk math derives from the detected budget, so bulk
  inserts on better-sqlite3 use ~33× fewer statements (111-row chunks →
  3,640-row chunks), and batched writes on D1 no longer exceed its
  per-statement limit. `capabilities.maxBindParameters` reports the
  detected value and remains overridable.
- `importGraph()` now refreshes planner statistics (`ANALYZE`)
  automatically after an import that created or updated rows, and
  `store.materializeIndexes()` does the same on SQLite after creating
  indexes. Stale statistics after bulk loads previously degraded
  traversals ~10× on PostgreSQL and some FTS5 queries ~30× on SQLite until
  the engine caught up on its own. Both verbs accept
  `refreshStatistics: false` to opt out. On PostgreSQL,
  `materializeIndexes()` builds with `CREATE INDEX CONCURRENTLY` and skips
  the automatic refresh (concurrent same-index builds from two callers can
  deadlock when a refresh shifts their timing) — call
  `store.refreshStatistics()` after materializing.
- PostgreSQL `refreshStatistics()` now issues one `ANALYZE (SKIP_LOCKED)`
  per table instead of a single multi-table `ANALYZE`. A multi-table
  ANALYZE is one transaction acquiring several ShareUpdateExclusive locks
  in sequence, and ANALYZE's lock class conflicts with in-flight
  `CREATE INDEX CONCURRENTLY` builds — the old shape could deadlock
  against concurrent index DDL; the new one can never join a lock-wait
  cycle (a locked table is skipped and covered by the next refresh or
  autovacuum).
