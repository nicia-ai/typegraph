---
"@nicia-ai/typegraph": minor
---

Add an immutable typed mutation planner for ordered node and edge creates, patches, replacements, and deletes. Eligible graphs plan from affected rows and constraint peers instead of cloning unrelated graph data; unsupported bounded scopes refuse unless full planning is explicitly selected. Plans remain ordinary serializable merge artifacts with revision fences and atomic application.

Reviewed batches can supply a persisted `expectedTarget` fence when authoring resumes. Planning refuses postimages that the native wire executor would reject or transform again; use deterministic schemas that accept their persisted JSON representation. This prevents producing an approved artifact that changes the staged value on application.

Persist authoring with the versioned JSON mutation document returned by `builder.document`, and resume through `planMutations`. New merge artifacts use format 2 to represent validity clearing and delete/recreate semantics; existing format 1 artifacts remain readable. Recreation resets the complete validity window, and staged collection refusals retain the operation index and original cause.

Upgrade `planCandidateWriteSet`, `planCandidateWriteSetReview`, and `revalidateCandidateWriteSetReview` callers that require full cloning to pass `planningScope: "full"`; implicit full-copy fallback is removed. Candidate evolution planning currently requires this explicit scope.

Evolution candidate planning now requires `planningScope: "full"` in both its type and runtime contract. Bounded-capability refusals expose `details.capability` and the required planning scope. `PlanningScope`, `MUTATION_DOCUMENT_FORMAT_VERSION`, and `MutationDocumentSchema` are public contracts for authoring and validating persisted documents.

Every candidate-planning scope requires revision tracking; choosing full scope does not enable it. Invalid scope diagnostics use `rejectedPlanningScope`, while `planningScope` names a required scope. The public mutation schema rejects duplicate property removals and overlapping sets/removals before consulting graph state.

Mutation document validity bounds must be canonical UTC instants with fixed milliseconds. Explicit create windows must have `validFrom <= validTo`; zero-width and unbounded windows remain valid. Invalid planning scope is refused before target capability checks, shared with ordinary merge planning.
