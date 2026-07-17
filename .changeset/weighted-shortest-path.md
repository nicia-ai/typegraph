---
"@nicia-ai/typegraph": minor
---

Add `store.algorithms.weightedShortestPath` — a minimum-total-weight path
search weighting each traversed edge by a numeric edge property (LDBC
Interactive IC14 shape). Runs frontier-based relaxation on the shared
iterative substrate with best-target pruning, works on both execution paths
(temporary working table and inline fallback), and honors valid-time and
recorded-time coordinates including pinned StoreViews. Edge weights are
audited up front: negative, non-numeric, out-of-range, or (without
`defaultWeight`) missing weights throw the new typed
`InvalidEdgeWeightError`. Weight arithmetic is IEEE 754 double precision on
both backends, so total weights are backend-identical; among
equal-total-weight paths the returned node sequence is too, except when the
`edges` list exceeds the backend's bind-parameter budget (hundreds of edge
kinds in one call).
