---
"@nicia-ai/typegraph": minor
---

Expose the schema-commit surface's decisions as data instead of prose, so
callers can pre-flight a proposal and classify a failure without matching
message text.

`MigrationError` now carries a stable `details.reason` discriminant —
`"schema-behind" | "breaking-change" | "no-active-version" |
"version-not-found"` (exported as `MIGRATION_FAILURE_REASONS`) — plus the
structured `details.diff` for the outcomes that computed one. Branch on
`details.diff.hasBreakingChanges` to tell an additive change from an
incompatible one, with no re-query and no substring matching. Note that
`MigrationErrorDetails.reason` is now required rather than an optional free-text
string.

For pre-flight, `classifySchemaChanges(diff)` reduces a diff to
`"identical" | "additive" | "incompatible"`, and the existing SELECT-only
`getSchemaChanges` is now reachable from a store handle: `store.schemaChanges()`
returns the diff and `store.requiresMigration()` answers the boolean predicate
(also `true` when nothing has been committed yet). A least-privilege runtime can
detect that it needs the privileged bootstrap instead of discovering the
migration wall partway through a request.

Documents two operational facts that were previously invisible at the call site:
kinds are scoped to the `graph_id` (a namespace *is* a graph id — separate
declaration sites do not isolate kinds), and running many `graph_id`s with
divergent schemas in one database is a supported multi-tenant pattern, including
the one cross-graph coupling (SQL index names are database-global, so identical
kind+index shapes share a physical index and divergent shapes fail loudly).

Also fixes `getSchemaChanges` to fold in the persisted graph-extension before
diffing, matching what the commit path already does. Without it a compile-time
graph was compared against a stored schema that also contains runtime-committed
kinds, so those kinds read as removals and an unchanged schema was reported as
requiring a breaking migration.
