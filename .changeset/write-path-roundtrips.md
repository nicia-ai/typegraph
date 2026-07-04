---
"@nicia-ai/typegraph": minor
---

perf: cascade deletes batch their edge removals — new optional `GraphBackend.deleteEdgesBatch` / `hardDeleteEdgesBatch` members issue one statement per bind-budget chunk instead of one per connected edge (50-edge cascade on local PostgreSQL: 24.4ms → 3.6ms), with recorded-time capture preserved. `getOrCreate` variants no longer run the full Zod parse twice on the create leg.
