---
"@nicia-ai/typegraph": minor
---

Add portable durable caller-key outcomes for ordinary Store transactions and composed merge applications through `captureStoreOperationTarget`, `operateStore`, and `getStoreOperation`. Requests bind an immutable canonical mutation/metadata digest to their allocation origin and storage namespace. Native mutations, JSON results, and exact transaction receipts commit atomically; identical retries replay the original outcome before invoking the mutation, and conflicting payloads refuse. Outcomes survive lost responses and process restart without a cache or reopened durable branch.

Base-schema version 8 installs the operation-evidence relation. Upgrade storage before enabling `durableStoreOperations`; unsupported backends and engine-native targets without TypeGraph revision origins refuse before mutation. Persist the complete request, including its captured target, before the first attempt and reuse it across retries. Evidence and caller-key bindings are retained for the allocation lifetime; `clear()` destructively retires them and old requests refuse rather than executing in the replacement origin. There is no implicit eviction or key reuse. Mutation callbacks must use their supplied transaction context and return JSON data; external side effects are outside its atomicity guarantee.

Complete `PostgresTableNames` / `SqliteTableNames` maps must include `storeOperations`. Custom PostgreSQL working-copy connectors must bind outcome storage to the allocated namespace; partial table-name overrides continue to use defaults.
