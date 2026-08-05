---
"@nicia-ai/typegraph": minor
---

**The merge commit proves its own identity result.** After a merge commit's
identity DML, and inside the same transaction, the applier now re-derives the
identity classes the merge TOUCHED and refuses a contradiction there — a class
whose member kinds the ontology declares disjoint, or a current `different`
assertion whose endpoints share a class. Both commit modes run it, seeded from
the planned assertion and retraction endpoints plus (under
`sameIdAcrossKinds: "fold"`) the node identities the commit writes, so the cost
is proportional to the affected classes rather than the graph.

This makes a committed identity ledger correct independently of the plan-time
simulation, which reasons about state read before any write. The simulation and
the commit-window fingerprints remain as the diagnosability layer: they refuse
early, before anything is written, naming exactly what drifted.

Because the scans resolve classes through the materialized closure — the same
authority every current identity read uses — a closure that lags its ledger can
hide a contradiction as easily as invent one. On any inconsistency the closure
is rebuilt from the base relations inside the commit transaction and the scans
re-run against it: a clean second pass means the closure was stale and is now
repaired atomically with the merge, while a repeated contradiction aborts the
whole merge. There is no partial commit either way.

`IdentityContradictionErrorDetails.operation` gained a `"merge"` member for
this refusal, which reaches callers as the existing
`IdentityMergeConflictError` (`GRAPH_MERGE_IDENTITY_CONFLICT`) with the
contradiction as its cause.
