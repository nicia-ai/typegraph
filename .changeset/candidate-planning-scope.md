---
"@nicia-ai/typegraph": minor
---

**Candidate planning reports the scope it planned in.** `planCandidateWriteSet()` stages a candidate from its own rows when the target allows it and from a clone of the whole target otherwise. That choice was a silent boolean; it is now a decision with a reason, returned beside the plan as `planningScope`: `{ scope: "candidate" }`, or `{ scope: "whole-target", reason }` where `reason` is one of `revision-tracking-disabled`, `composition`, `acyclic-relation`, `target-side-cardinality`, `missing-active-source-read`, `missing-match-identity-read`, `missing-scoped-identity-reads`, `match-identity-owners-unavailable`, `match-identity-owner-not-clone-visible` or `planned-evolution`. Both scopes produce the same plan, so the scope is not part of the merge plan artifact or its digest and `MERGE_PLAN_FORMAT_VERSION` is unchanged. The new `CandidatePlanningScope`, `CandidatePlanningScopeReason`, `WholeTargetPlanningScope` and `CandidateWriteSetPlan` types are exported from `@nicia-ai/typegraph/graph-merge`.

**`planningScope: "candidate"` makes the candidate scope a requirement.** Passed to `planCandidateWriteSet()` or `planCandidateWriteSetForEvolution()`, it refuses with the new `CandidatePlanningScopeError` (`GRAPH_MERGE_CANDIDATE_PLANNING_SCOPE`, `details.planningScope.reason`) instead of planning against the whole target, before any staging backend is created. `planCandidateWriteSetForEvolution()` always stages the whole resulting graph, so it reports `planned-evolution` and refuses the option. The review entry points forward it to planning. A refused candidate-scoped review (`details.reason: "candidate-scope-ineligible"`) now also carries `details.planningScope` naming the cause.

### Breaking

- `planCandidateWriteSet()` and `planCandidateWriteSetForEvolution()` now resolve to `Result<CandidateWriteSetPlan, MergeError>`, `{ plan, planningScope }`, instead of the bare `MergePlanArtifact`. Read the artifact from `result.data.plan`, for example `const { plan } = unwrap(await planCandidateWriteSet(args))`.
