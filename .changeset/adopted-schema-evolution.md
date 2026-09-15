---
"@nicia-ai/typegraph": minor
---

Plan schema evolution outside a write transaction with `store.planEvolution()`, then apply the version-bound plan alongside graph and application writes through `store.withEvolvedTransaction()`. Plans are opaque, nonserializable capability tokens that can move between compatible Stores from the same loaded module, including `withBackend()` request Stores. They expose `baseline` and `result` schema identities and discriminated requirements for routing. No-op plans can use ordinary recorded transactions; metadata-only changes avoid entity scans and provisioning DDL. Schema fence waits are bounded and expose `SchemaFenceTimeoutError` for whole-transaction retry.

Evolved callbacks use the resulting schema, support recorded revision requests, and return exact schema version/hash metadata alongside the provisional recorded receipt. Escaped TypeGraph reads and writes refuse after callback completion. Publish root Store changes after outer commit through read-only `refreshSchema({ ref, minVersion })`; a matching cached version needs no reload.

Use `branchForEvolution()` to fork an isolated branch with the planned kind set and `planMergeForEvolution()` to prepare a merge for the resulting schema and apply it inside the evolved callback. Old-schema merge plans continue to refuse. Adapters default to a DML-only policy that refuses required identity or vector provisioning before mutation. Privileged adapters configured with `schemaProvisioning: "transactional"` provision identity storage, vector tables, and contribution markers on the caller's fenced transaction session, so outer rollback removes them with the schema and graph writes. Bootstrap storage is still required, and eager index maintenance runs explicitly after commit. SQLite schema adoption requires verifiable native transaction state, and noninteractive drivers remain unsupported.

Custom implementations of the `StoreEvolution` interface must add `planEvolution()` and `refreshSchema()`. Custom `SqlEngineProfile` and `AdapterBackend` implementations must declare their schema provisioning policy explicitly; the bundled adapters default to `"dml-only"`.
