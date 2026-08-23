---
"@nicia-ai/typegraph": minor
---

Introduce authoritative node create plans and reduce first-party PostgreSQL write round trips by folding schema and graph fences, uniqueness and disjointness verdicts, endpoint and cardinality checks, and generated fulltext/vector projections into atomic statements. Managed Store transactions now lease one schema fence across their writes without sacrificing the fused first statement, and endpoint get-or-create decisions are confirmed from transaction-scoped evidence on caching transports.

The backend planning API is renamed from `NodeInsertPlan` and `insertNodeWithProjections` to `NodeCreatePlan` and `executeNodeCreatePlan`. Custom backends retain the portable write fallback, while existing persisted claim rows remain supported.
