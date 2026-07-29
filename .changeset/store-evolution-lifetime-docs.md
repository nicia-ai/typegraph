---
"@nicia-ai/typegraph": patch
---

Clarify that schema-managed Stores are immutable schema snapshots. After
`evolve()` changes the schema, callers must use the returned Store or the
updated `StoreRef.current` for subsequent work; a previously captured Store is
not mutated and its managed writes are rejected by the schema-version fence.
Document how long-lived caches detect schema commits from other processes with
`getCommittedSchemaVersion()` and refresh through a verified Store open.

Correct the `StoreRef` contract to say that the replacement is installed before
a successful schema-changing call resolves, rather than claiming that the
in-memory ref update is atomic with the persisted schema commit.
