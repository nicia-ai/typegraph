---
"@nicia-ai/typegraph": minor
---

Compose eligible node claim sets and fulltext/vector projections inside the same schema-fenced atomic `bulkInsert()` and `bulkCreate()` program. Multiple uniqueness constraints, hierarchy-wide uniqueness scopes, disjointness claims, caller/generated ID mixtures, and claim-plus-projection members now retain one Neon HTTP, Cloudflare D1, or libSQL transport submission and the same pinned PostgreSQL transaction program. Legacy claim-axis conflicts keep their typed errors and roll back every row and projection sidecar.

Claimed node programs now chunk row statements by actual per-member claim work inside one atomic submission instead of imposing a batch-wide claim ceiling. The custom-backend claim contract is correspondingly simplified from family-scoped batch ceilings to `claimSupport.families` plus `claimSupport.maxInputCostPerEntry`; backend authors use the exported `atomicNodeClaimInputCost()` owner rather than reproducing the compiled SQL cost model.

Claim refusal is enforced by a terminal database assertion so every row and projection chunk rolls back before failure-only committed-state reads recover the portable path's typed diagnostic.
