---
"@nicia-ai/typegraph": minor
---

Plan schema evolution outside a write transaction with `store.planEvolution()`, then apply the version-bound plan alongside graph and application writes through `store.withEvolvedTransaction()`. No-op plans can use ordinary recorded transactions; metadata-only changes avoid entity scans and provisioning DDL. Schema fence waits are bounded and expose `SchemaFenceTimeoutError` for whole-transaction retry.

Evolved callbacks use the resulting schema, support recorded revision requests, and return exact schema version/hash metadata alongside the provisional recorded receipt. Escaped TypeGraph reads and writes refuse after callback completion. Publish root Store changes after outer commit through read-only `refreshSchema({ ref, expectedVersion })`; a matching cached version needs no reload.

Use `branchForEvolution()` to fork an isolated branch with the planned kind set and `planMergeForEvolution()` to prepare a merge for the resulting schema and apply it inside the evolved callback. Old-schema merge plans continue to refuse. Request-side evolution refuses vector and identity provisioning requirements before mutation; route those plans through privileged bootstrap. SQLite schema adoption requires verifiable native transaction state, and noninteractive drivers remain unsupported.
