---
"@nicia-ai/typegraph": minor
---

Introduce authoritative node create commands and reduce first-party PostgreSQL write round trips by folding schema and graph fences, uniqueness and disjointness verdicts, endpoint and cardinality checks, and generated fulltext/vector projections into atomic statements. Managed Store transactions now lease one schema fence across their writes without sacrificing the fused first statement, and endpoint get-or-create decisions are confirmed from transaction-scoped evidence on caching transports.

The backend planning API now uses one required semantic command port for node and edge creates. Commands carry an explicit root or transaction session and, when an advisory graph lock was actually acquired, a graph- and port-bound coordination token; custom backends implement that same contract rather than silently falling back to a second decision path.

Breaking change and migration: add `commands: { session, execute }` to custom `GraphBackend` objects and route node/edge create plans through it. A backend that cannot honor a requested plan dimension must return its typed `unsupported` result; it must not silently ignore the dimension. See the authoritative command sessions section of the backend setup guide.
