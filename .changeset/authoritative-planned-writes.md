---
"@nicia-ai/typegraph": minor
---

Introduce authoritative node create commands and reduce first-party PostgreSQL write round trips by folding schema and graph fences, uniqueness and disjointness verdicts, endpoint and cardinality checks, and generated fulltext/vector projections into atomic statements. Managed Store transactions now lease one schema fence across their writes without sacrificing the fused first statement, and endpoint get-or-create decisions are confirmed from transaction-scoped evidence on caching transports.

The backend planning API now uses one required semantic command port for authoritative node and edge creates. Every command carries an explicit session, atomicity, authority, and result-cache policy; custom backends implement that same contract rather than silently falling back to a second decision path.
