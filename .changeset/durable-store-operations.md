---
"@nicia-ai/typegraph": minor
---

Add portable durable caller-key outcomes for ordinary Store transactions and composed merge applications through `captureStoreOperationTarget`, `operateStore`, and `getStoreOperation`. Requests bind an immutable canonical mutation/metadata digest to their allocation origin and storage namespace. Native mutations, JSON results, and exact transaction receipts commit atomically; identical retries replay the original outcome before invoking the mutation, and conflicting payloads refuse. Outcomes survive lost responses and process restart without a cache or reopened durable branch.

Base-schema version 8 installs the operation-evidence relation. Upgrade storage before enabling `durableStoreOperations`; unsupported backends and engine-native targets without TypeGraph revision origins refuse before mutation. Persist the complete request, including its captured target, before the first attempt and reuse it across retries. Evidence and caller-key bindings are retained for the allocation lifetime; `clear()` destructively retires them and old requests refuse rather than executing in the replacement origin. There is no implicit eviction or key reuse. Mutation callbacks must use their supplied transaction context and return JSON data; external side effects are outside its atomicity guarantee.

Complete `PostgresTableNames` / `SqliteTableNames` maps must include `storeOperations`. Custom PostgreSQL working-copy connectors must bind outcome storage to the allocated namespace; partial table-name overrides continue to use defaults.

Ordinary Store operations share durable request validation, expose verified full-request lookup as well as explicit key-only lookup, and expose attempt-scoped `StoreOperationError.attemptOutcome` separately from durable key evidence. Evidence format 2 binds the complete allocation owner; divergent physical forks must explicitly rotate it before writes. The Result-based helpers and their errors/types are exported from `/graph-merge`. `DurableOperationRequest` is the canonical request shape; the branch-specific name is an alias.

New caller keys must contain 1–256 UTF-8 bytes; invalid keys refuse before invoking a mutation callback. Always retry using the same persisted target, key, mutation, and metadata. A failed attempt never proves that a key has no earlier committed outcome. Lost replay responses report uncertainty and support same-request recovery, and transient contention, expired-session, and transport failures are retryable.

For durable branch evidence, the admission cap does not apply to retained keys: older oversized keys remain available for lookup, scanning, and delivery acknowledgement after upgrade. Do not resubmit an earlier request under a replacement key; its original binding remains authoritative.

Store-operation lookups enforce the same key limit as new Store mutations; retained oversized branch keys remain recoverable. Unknown-attempt errors require retrying the same persisted request, and lookup absence never authorizes a replacement key.

PostgreSQL expired transactions (`25P03`) and idle sessions (`57P05`) permit same-request retry on a fresh transaction or connection. When this attempt is known not to have committed, protocol violations (`08P01`), query cancellation (`57014`), and an intentionally closed `pg` client do not trigger automatic retry. Unknown outcomes always permit recovery with the same persisted request, using repaired or replacement connections when needed.

Allocation-owner refusals use `DurableOperationOwnerMismatchError` and the shared `GRAPH_ALLOCATION_OWNER_MISMATCH` code. Both origin and namespace belong to the immutable owner binding.
