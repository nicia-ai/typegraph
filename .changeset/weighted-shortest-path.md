---
"@nicia-ai/typegraph": minor
---

Add `store.algorithms.weightedShortestPath` — a minimum-total-weight path
search weighting each traversed edge by a numeric edge property (LDBC
Interactive IC14 shape). Runs frontier-based relaxation on the shared
iterative substrate with best-target pruning, works on both execution paths
(temporary working table and inline fallback), and honors valid-time and
recorded-time coordinates including pinned StoreViews. Edge weights are
audited up front: negative, non-numeric, or (without `defaultWeight`)
missing weights throw the new typed `InvalidEdgeWeightError`. Weight
arithmetic is IEEE 754 double precision on both backends, so paths and
totals are backend-identical.
