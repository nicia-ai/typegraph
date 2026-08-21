---
"@nicia-ai/typegraph": minor
---

Custom backend capabilities now resolve through six shared bundles instead of scattered `undefined` checks. This makes each operation family consistently choose one of three outcomes: use the declared member, take its documented fallback, or refuse with a typed error.

The pilot covers `claims`, `statementExecution`, `recordedRevisionOrigins`, `batchPointRead`, `uniqueSidecarBatch`, and `contributionHealth`. Batch point reads and supported sidecar operations degrade to their existing per-item implementations when the batch member is absent. Operations without a safe fallback keep their existing typed refusal. A backend whose capability declaration disagrees with the members reachable on its execution port now refuses with `CONSTRAINT_CLAIM_SURFACE_MISMATCH` for claims or `BUNDLE_PORT_SURFACE_MISMATCH` for the other bundles.

`CAPABILITY_BUNDLES`, the six named definitions, their verdict and binding types, and the `resolveBundle`, `bindCore`, `bindExtra`, and `bindExtraIfReachable` helpers are public for backend conformance tooling. Both bundled backends already implement every required member, so their behavior is unchanged.

This pilot covers six of twenty-one member-bearing operation families; the other fifteen continue to work through their existing paths. See [Capability bundles](https://typegraph.dev/backend-setup#capability-bundles) for the complete member and fallback matrix.
