---
"@nicia-ai/typegraph": minor
---

Fence edge cardinality with a claim relation, and enforce it under `importGraph`.

Declared edge cardinality was probed and never fenced. `one` and `oneActive` are predicates over `(kind, from)` and `unique` is one over `(kind, from, to)`, while the edges relation's only uniqueness is its `(graph_id, id)` primary key — so two writers could both count zero sibling edges and both commit, and nothing in the schema re-decided at write time. `importGraph` made it worse by running no cardinality probe at all: a payload could commit any number of edges a `cardinality: "one"` declaration forbids.

A new relation, `typegraph_edge_claims`, keyed `(graph_id, axis, key)`, is the fence. Each constrained edge write reserves the axis its declaration spans (`<cardinality>:<edgeKind>`) against the endpoint identity the declaration covers, in two statements: a decision-free create-or-lock that reports the committed holder, then — only when the holder is a different edge — a conditional takeover that succeeds exactly when that holder is no longer an edge the axis and key describe. Deciding inside one upsert would read the pre-lock snapshot of the edges relation under READ COMMITTED and accept both writers; the split is what makes the second one lose.

The claim needs no release path. A holder that is soft-deleted, hard-deleted, or (for `oneActive`) ended fails the takeover's liveness predicate and is replaced in place, so no delete, end, cascade or kind-removal path participates in the fence. The holder is identified by its kind and source endpoints as well as its id, because edge ids are caller-suppliable: a reused id would otherwise read as a live holder and block its axis forever. `EDGE_CARDINALITY_SPECS` is the one table both the TypeScript probe and the takeover's SQL read for which endpoints an axis covers, whether an edge born already ended claims at all, and what a holder must still be — so the probe and the fence cannot drift apart.

Behavior deltas:

- **Import now enforces edge cardinality** (`one` / `unique` / `oneActive`). Two edges from one source in one payload refuse the second **row** and report it in `errors` while the import continues; the accepted rows commit. Import's edge slice reuses the store's own in-batch cardinality accounting to make that per-row rather than a whole-slice abort. A *concurrent* violation, taken by another writer between a row's probe and the slice's claim, still surfaces from the claim and aborts the import — the same asymmetry import already has for uniqueness.
- **`PostgresTableNames` / `SqliteTableNames` / `SqlTableNames` gain `edgeClaims`**, and `BackendCapabilities` gains an **optional** `constraintClaims`. Absent means `false`: a backend that predates the claim relations keeps every fence it has today and is never refused for the absence. Both bundled dialects declare `true` and implement every claim member. A backend whose declaration and surface disagree in either direction is refused with `ConfigurationError` / `CONSTRAINT_CLAIM_SURFACE_MISMATCH` rather than silently unfenced.
- **`GraphBackend` gains optional `claimEdgeCardinality`, `claimEdgeCardinalityBatch` and `purgeEdgeClaims`.** Additive; a custom backend that omits them declares `constraintClaims: false` and keeps working.
- **A database bootstrapped before this release needs the new table.** It is emitted by the existing idempotent boot path and by `generatePostgresMigrationSQL` / `generateSqliteMigrationSQL`. A store reaching a missing relation on its first constrained edge write is refused with a typed `ConfigurationError` (`EDGE_CLAIM_RELATION_MISSING`) naming the relation and the migration to run, instead of an opaque driver failure.

The refusal a caller sees is the family's own `CardinalityError`, built by the same functions the probe calls, so it is indistinguishable from the serial refusal it replaces.
