---
"@nicia-ai/typegraph": minor
---

Fix `migrateSchema()` silently dropping runtime-committed kinds

`migrateSchema(backend, graph, currentVersion)` committed `graph` verbatim. It
did not fold the persisted graph extension, so kinds committed at runtime by
`Store.evolve()` — which live in `schema_doc.extension`, not in the
compile-time graph — were erased from the active schema document while their
rows stayed in `typegraph_nodes` / `typegraph_edges`, reachable by nothing and
with no `typegraph_kind_removals` row ever queued to clean them up.

This was reachable by following the library's own advice: the `MigrationError`
raised for a breaking change told callers to "use `getSchemaChanges()` to
review, then `migrateSchema()` to apply", and doing so with the graph they
passed to `createStoreWithSchema` destroyed every `evolve()`-committed kind.

Two changes:

- **The persisted graph extension is now folded in**, exactly as
  `createStoreWithSchema` and `getSchemaChanges` already did. Callers pass the
  graph they have; runtime-committed kinds survive.
- **A commit that would drop kinds is refused** with a `MigrationError` whose
  `details.reason` is the new `"kind-removal"` discriminant and whose
  `details.droppedKinds` names them. `Store.removeKinds()` remains the removal
  path — it queues the data-cleanup rows that make a removal reconcilable. Pass
  `{ allowKindRemoval: true }` to accept the orphaning deliberately.

Breaking property changes — the documented reason to reach for
`migrateSchema()` — are unaffected.
