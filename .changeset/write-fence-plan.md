---
"@nicia-ai/typegraph": minor
---

A custom `GraphBackend` — one not built by `createSqliteBackend` or `createPostgresBackend` — that hosts Operational Identity, `history: true`, or `revisionTracking: true`, and does not declare `capabilities.pessimisticLocks`, is now refused at store construction, immediately, with no deprecation release. The refusal message names the exact one-line declaration to add, keyed to the backend's dialect (for example `pessimisticLocks: { advisoryLocks: true, tableLocks: true, serializedWriters: false }` for PostgreSQL, `pessimisticLocks: { advisoryLocks: false, tableLocks: false, serializedWriters: true }` for SQLite), so the error text is the migration guide rather than a pointer to documentation.

`BackendCapabilities` gains an optional `pessimisticLocks` field (`{ advisoryLocks, tableLocks, serializedWriters }`) declaring how an engine serializes concurrent writers, if at all. `resolveWriteFencePlan` is the one place that declaration turns into a `WriteFencePlan` (`lock` / `engine-serialized` / `unfenced`) every lock site now consumes instead of re-deriving from `dialect` inline, and `requireWriteFence` is the one place an operation's specific lock requirement (`"advisory-lock"` / `"table-lock"`) is checked against the resolved plan, refusing with `WRITE_FENCE_UNAVAILABLE` when it cannot be met. This consolidates eight call sites that used to spell the same dialect-keyed decision independently.

`BackendCapabilities` also gains an optional `recordedTimeOwnership` field (`"typegraph-relations"` | `"engine-native"`) naming who allocates recorded-time revisions. Absent means `"typegraph-relations"` — today's behavior for every existing backend. Declaring `"engine-native"` together with `history`/`revisionTracking` is refused at construction with `ENGINE_NATIVE_RECORDED_TIME_NOT_IMPLEMENTED` as an interim measure, independently of the write-fence plan, because the engine-native read/write path does not exist yet; a later release lifts this refusal with that path.

Both bundled backends declare `pessimisticLocks` unconditionally, so no shipped configuration changes behavior.
