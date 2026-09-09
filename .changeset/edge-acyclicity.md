---
"@nicia-ai/typegraph": minor
---

An edge registration accepts `acyclic: true`, declaring that the edge kind's
live relation is a DAG. Every write path that can put an edge into that
relation — `create`, `bulkCreate`, upsert and `getOrCreateByEndpoints`,
resurrection into the live population, validating import, and merge apply —
is refused with the new `EdgeAcyclicityError` when the new edge's `to`
endpoint already reaches its `from` endpoint; a self-loop is a cycle of
length one and is refused by the same rule. The check is exhaustive: a
set-semantics recursive reachability with no depth bound, so
`MAX_EXPLICIT_RECURSIVE_DEPTH` does not apply and a cycle of any length is
found. Non-deleted edges count regardless of their validity window, so
ending an edge's window does not free the relation while soft-deleting it
does. The probe and the write it guards commit under the same per-graph
write fence that already fences edge cardinality and node disjointness, so
two concurrent writers of `a → b` and `b → a` serialize and exactly one
commits; a backend with no transactions refuses the write with
`CONSTRAINT_WRITE_FENCE_UNSUPPORTED` and the new `details.constraint` value
`edgeAcyclicity` rather than enforcing the rule only when nothing races, and
a session that cannot observe a commit that landed while it waited for the
fence is refused with `EDGE_ACYCLICITY_REQUIRES_FRESH_SNAPSHOT`. A statement
the engine cuts short raises the new `EdgeAcyclicityIndeterminateError`; an
incomplete search is never reported as "no cycle". `store.verifyConstraintFences()`
gains an `edgeAcyclicity` family reporting edges already on a cycle, and
adding `acyclic: true` to a populated kind is classified as a tightening and
refused (`MigrationError` `reason: "ontology-tightening-violated"`) when the
data already violates it. `trustedImportGraphStream` refuses a store
declaring an acyclic edge kind (`reason: "acyclicity_unsupported"`); the
portable validating import checks each row as it writes and rolls it back
per-row on a cycle, taking the per-graph write fence per chunk only when the
graph declares an acyclic edge kind. Fused/atomic native write programs
report `unsupported` for acyclic kinds and fall back to the portable fenced
path. `ConstraintFenceViolation` is now a four-member union whose `target`
is present only on the claim-backed families, so consumers must narrow on
`family` before reading it.

Graph-merge catches a would-be cycle earlier, at PLAN time: `merge()`,
`mergeAgainstBase()`, `planMerge()`, `planMergeIncremental()`, and
`mergeIncremental()` all run the same reachability check over the resolved
plan's projected edge writes (after canonicalization and repointing), layered
onto the target's current live edges — including a cycle formed entirely from
rows the plan itself proposes, with nothing live yet, which the reachability
walk did not previously have a way to see. A violation is now the new typed
`AcyclicityMergeConflictError` (code `GRAPH_MERGE_ACYCLICITY_CONFLICT`),
carrying the offending relation name and every edge on the cycle
(`edgeId`/`edgeKind`/`fromKind`/`fromId`/`toKind`/`toId`) in `details`, so a
`planMerge()` review surfaces the conflict before anything is written. A
cycle that only appears from a write racing the plan (the preview takes no
per-graph write lock) is still caught by the unchanged apply-time write-path
fence and reported as `MergeConstraintConflictError` wrapping
`EdgeAcyclicityError`, exactly as before.

### Breaking changes

- `ConstraintFenceViolation` gains an `edgeAcyclicity` member alongside the
  existing `edgeEndpointAssignability` member without a claim `target`. Code
  that reads `violation.target` unconditionally must narrow on `violation.family`
  first.
- `EdgeIntrospection.acyclic` is now a required `boolean` field (`false` for
  every edge kind that does not declare `acyclic: true`).
- A merge whose resolved plan would close a cycle now fails with the new
  `AcyclicityMergeConflictError` at plan time rather than
  `MergeConstraintConflictError` at apply time. Code that specifically
  catches `MergeConstraintConflictError` (or matches on
  `cause.name === "EdgeAcyclicityError"`) to detect this case must also
  handle `AcyclicityMergeConflictError`; the apply-time shape still occurs
  for a cycle that only appears from a write racing the plan.

### Upgrade notes

- Adding `acyclic: true` to a populated edge kind is probed against live rows
  inside the commit transaction and refused with `MigrationError`
  `reason: "ontology-tightening-violated"` when a cycle already exists;
  inspect `details.violations` (same shape as `store.verifyConstraintFences()`)
  to find and resolve the offending rows before retrying.
- A backend without transaction support cannot enforce acyclicity at all;
  writes to an acyclic edge kind are refused with `CONSTRAINT_WRITE_FENCE_UNSUPPORTED`
  rather than silently skipping the check.
- Graph extensions may declare `acyclic` on a runtime-authored edge,
  alongside `cardinality` / `targetCardinality`.
