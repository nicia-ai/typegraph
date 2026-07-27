---
"@nicia-ai/typegraph": minor
---

Export the committed-schema reads from the package root. `getActiveSchema`,
`isSchemaInitialized`, and the `SerializedSchema` type now sit next to
`getCommittedSchemaVersion` in `@nicia-ai/typegraph`, so answering "what kinds
does this database already have?" no longer requires finding the
`@nicia-ai/typegraph/schema` subpath or querying `typegraph_schema_versions`
by hand. `getActiveSchema` and `getCommittedSchemaVersion` now cross-reference
each other in their docstrings.
