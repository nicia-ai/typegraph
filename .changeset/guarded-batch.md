---
"@nicia-ai/typegraph": minor
---

A backend whose `capabilities.execution.unitOfWork` is `"batch"` (Cloudflare D1's `batch()`, Neon
HTTP's `transaction(queries)`) fixes every statement before the first one runs and commits them
together with no session in between. `resolveBatchWriteVerdict` in
`src/backend/capabilities/batch-write-verdict.ts` is the one place that classifies a schema-managed
write's fitness for that tier: given a write's already-proven need (an interactive callback, a
probe-then-write constraint check, Operational Identity, history, or a schema commit), it either
defers (any other tier) or returns a refusal carrying a stable `BATCH_WRITE_UNSUPPORTED` code, the
reason, and a canonical explanation. Every enforcing gate that used to word its own batch-engine
limitation independently — the constrained-write fence, `store.transaction`, Operational Identity's
atomic-backend checks, recorded-time capture's transactionability guards, and each dialect's
schema-commit refusal — now asks this one verdict for its phrasing and nests
`{ code: "BATCH_WRITE_UNSUPPORTED", reason }` under `details.batchRefusal`, so every refusal on a
batch-tier backend names the same reason in the same words. The portable schema-version fence keeps
its plain, reasonless `SCHEMA_WRITE_FENCE_UNSUPPORTED` limitation for everything it reaches that
isn't one of those five proven needs — an ineligible write kind, a derived backend, a provenance
mismatch — rather than guessing which reason, if any, applies.

A singleton node `create` with a caller-supplied id now fuses its schema fence on a batch-tier
backend exactly as a generated id already did, provided the kind carries no declared unique
constraint: the id-generation gate that existed for an interactive root's autocommit durability no
longer excludes a batch program, which commits its one statement as a unit regardless of which id it
carries. `isAutocommitSingleStatementWrite` — the separate, stricter classifier for a bundled root's
transaction-free write — is deliberately not relaxed the same way: the fused supplied-id create
instead proves `insertNodeIfAbsentWithSchemaFence` through the ordinary hooked write plan, which
already selects the correct fenced statement per id. The tombstone-resurrection write a supplied id
can fall through to is fenced immediately before it runs, so it refuses on a batch-tier target rather
than writing the row unfenced.

`tests/batch-engine-harness.ts` adds a fake D1 client and a fake Neon HTTP client, each backed by a
real engine (better-sqlite3, PGlite) wrapped in a real transaction, so batch atomicity — a rollback
on a failing statement, a stale schema version writing nothing, every refusal reason reaching its
gate — is now proven against real engine behavior instead of a mocked response. Bundled interactive
behavior, emitted SQL, and the engine-profile-parity snapshot are unchanged.
