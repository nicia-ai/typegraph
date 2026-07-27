---
"@nicia-ai/typegraph": minor
---

Fix `migrateSchema()` silently dropping runtime-committed kinds

`migrateSchema(backend, graph, currentVersion)` committed `graph` verbatim. It
did not fold the persisted graph extension, so kinds committed at runtime by
`Store.evolve()` — which live in `schema_doc.extension`, not in the
compile-time graph — were erased from the active schema document while their
rows stayed in `typegraph_nodes` / `typegraph_edges`, reachable by nothing and
with no `typegraph_kind_removals` row ever queued to clean them up. The
persisted `deprecatedKinds` set was erased the same way.

This was reachable by following the library's own advice: the `MigrationError`
raised for a breaking change told callers to "use `getSchemaChanges()` to
review, then `migrateSchema()` to apply", and doing so with the graph they
passed to `createStoreWithSchema` destroyed every `evolve()`-committed kind.

Two changes:

- **The persisted graph extension (and deprecated-kind set) is now folded in**,
  exactly as `createStoreWithSchema` and `getSchemaChanges` already did.
  `migrateSchema` was the last commit path that did not. Callers pass the graph
  they have; runtime-committed kinds survive.
- **A commit that would drop a kind still holding rows is refused** with a
  `MigrationError` whose `details.reason` is the new `"kind-removal"`
  discriminant and whose `details.droppedKinds` names them. Pass
  `{ allowKindRemoval: true }` to accept the orphaning deliberately.

The guard fires on the actual harm — orphaned rows — not on kind removal as
such. Dropping an *empty* kind is unaffected, so the documented three-deploy
removal flow (stop writing → delete the rows → drop from `defineGraph()` and
migrate) still works exactly as written; Deploy 2 is now what makes Deploy 3
legal instead of being merely advisory. Live rows only, matching the
`excludeDeleted` default of the equivalent probe in `Store.evolve()`.

Breaking property changes — the documented reason to reach for
`migrateSchema()` — are unaffected.
