---
"@nicia-ai/typegraph": minor
---

Execute eligible durable-match and cardinality-constrained `edges.bulkInsert` and `edges.bulkCreate` calls as one schema-fenced atomic exchange on bundled Neon HTTP, Cloudflare D1, and libSQL roots. The program maintains stale-claim takeover and legacy-incumbent detection, preserves typed endpoint, match-identity, and cardinality refusals, and rolls back every edge row when any constraint sidecar fails.
