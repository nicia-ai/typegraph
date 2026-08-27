---
"@nicia-ai/typegraph": minor
---

Execute eligible durable `bulkGetOrCreateByEndpoints()` calls as one schema-fenced native atomic exchange on bundled Neon HTTP, Cloudflare D1, and libSQL roots. The eligible envelope is a schema-declared `matchIdentity` with `cardinality: "many"`, the declaration's match fields, default `ifExists: "return"`, and no temporal mutation. The program owns endpoint validation, identity arbitration, tombstone resurrection, input-order restoration, and whole-call rollback. Dynamic match fields, update mode, constrained cardinality, temporal options, caller-owned transactions, derived/custom backends, and history/revision stores retain their existing path.

The libSQL transport inventory measures one `batch` submission and zero `execute` calls for a multi-item eligible call. This is a transport submission-count measurement, not a wall-clock RTT benchmark.
