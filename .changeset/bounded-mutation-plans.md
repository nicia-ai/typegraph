---
"@nicia-ai/typegraph": minor
---

Add an immutable typed mutation planner for ordered node and edge creates, patches, replacements, and deletes. Eligible graphs plan from affected rows and constraint peers instead of cloning unrelated graph data; unsupported bounded scopes refuse unless full planning is explicitly selected. Plans remain ordinary serializable merge artifacts with revision fences and atomic application.

Reviewed batches can supply a persisted `expectedTarget` fence when authoring resumes. Planning refuses postimages that the native wire executor would reject or transform again; use deterministic schemas that accept their persisted JSON representation. This prevents producing an approved artifact that changes the staged value on application.
