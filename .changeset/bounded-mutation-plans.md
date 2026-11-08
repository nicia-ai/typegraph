---
"@nicia-ai/typegraph": minor
---

Add an immutable typed mutation planner for ordered node and edge creates, patches, replacements, and deletes. Eligible graphs plan from affected rows and constraint peers instead of cloning unrelated graph data; unsupported bounded scopes refuse unless full planning is explicitly selected. Plans remain ordinary serializable merge artifacts with revision fences and atomic application.

Reviewed batches can supply a persisted `expectedTarget` fence when authoring resumes. Planning refuses postimages that the native wire executor would reject or transform again; use deterministic schemas that accept their persisted JSON representation. This prevents producing an approved artifact that changes the staged value on application.

Persist authoring with the versioned JSON mutation document returned by `builder.document`, and resume through `planMutations`. New merge artifacts use format 2 to represent validity clearing and delete/recreate semantics; existing format 1 artifacts remain readable. Recreation resets the complete validity window, and staged collection refusals retain the operation index and original cause.

Upgrade candidate write-set callers that require full cloning to pass `planningScope: "full"`; implicit full-copy fallback is removed. Candidate evolution planning currently requires this explicit scope.
