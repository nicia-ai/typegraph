---
"@nicia-ai/typegraph": minor
---

Ship graph extensions for agent-driven schema induction.

Graph extensions let a running application accept a reviewed, JSON-serializable schema proposal and commit it as a durable TypeGraph schema version without redeploying application code.

Public API:

- `defineGraphExtension(input)` and `validateGraphExtension(input, options?)` build and validate pure graph-extension documents.
- `GraphExtension`, `ExtensionNodeDef`, `ExtensionEdgeDef`, `ExtensionPropertyType`, `ExtensionIndex`, version constants, and graph-extension error classes are exported for tool builders.
- `Store.evolve(extension, { ref?, eager? })` atomically commits the merged schema with CAS and returns a fresh store carrying the graph-extension-declared kinds.
- Graph-extension-declared kinds are reached through `getNodeCollection(kind)`, `getNodeCollectionOrThrow(kind)`, `getEdgeCollection(kind)`, and `getEdgeCollectionOrThrow(kind)`.
- `store.introspect()` returns the merged schema, origin markers, persisted extension, deprecation set, and known schema version/hash.
- `store.materializeIndexes()` materializes compile-time and graph-extension relational/vector indexes per deployment.
- `store.deprecateKinds()`, `store.undeprecateKinds()`, `store.removeKinds()`, and `store.materializeRemovals()` manage graph-extension-kind lifecycle after induction.

The v1 document subset supports nodes, edges, ontology relations, annotations, unique constraints, relational indexes, searchable string fields, and embedding fields. Restart parity is load-bearing: `createStoreWithSchema()` reads `schema_doc.extension`, recompiles the extension, and rebuilds the same Zod-bearing merged graph in a fresh process.

The final public naming is `defineGraphExtension`, not the earlier pre-release `defineRuntimeExtension` draft. The value being defined is a graph-extension document; the runtime action is `store.evolve()`. The corresponding subpath export is `@nicia-ai/typegraph/graph-extension` (renamed from the pre-release `@nicia-ai/typegraph/runtime` for the same reason). All graph-extension exports also remain available from the package root.

This release also tightens release-blocking validation and DX gaps:

- Missing index `fields` now fails at authoring time with `EMPTY_INDEX_FIELDS`.
- Duplicate graph-extension index names across separate evolves are rejected before persistence.
- Graph-extension index names are checked against compile-time index names on the merged graph.
- `store.introspect().schemaVersion` and `schemaHash` are preserved across `createStoreWithSchema()`, `evolve()`, deprecation updates, and removals.
- `validateGraphExtension(input, { strict: true })` and `defineGraphExtension(input)` now reject unknown sibling keys at every property level with the new `UNKNOWN_PROPERTY_KEY` issue. A typo like `minLenght: 5` on a string property used to compile silently to a constraint-less schema; the strict path catches it at the LLM/agent trust boundary. The persistence-load path stays loose so a future v1.x.y writer's additive refinements still parse on an older v1 reader.
- `store.evolve(extension)` no longer bumps the schema version when the extension is already applied to the persisted state on a stale store. Previously the no-op short-circuit compared against the local in-memory graph, so a writer catching up to another writer's identical commit would unnecessarily advance the version. The check now compares against the caught-up baseline; the call returns a clone wrapping the baseline so `introspect()` reflects the persisted version.
- `typegraph_kind_removals` is now keyed on `(graph_id, kind_name, entity, schema_version)` instead of `(graph_id, kind_name)`. Pre-release schema; no migration. The previous narrow key collapsed two distinct removals (re-add-then-re-remove of the same kind, or a node and an edge sharing a kind name) onto one row, where the COALESCE-on-failure rule preserved the prior `removed_at` and silently skipped the new pending cleanup.
- Published package exports now expose declarations through a first-class `types` condition so packed-artifact consumers resolve `@nicia-ai/typegraph` and subpath types correctly.
- The guide and runnable example now document extension-declared relational indexes, kind removal, deprecation through `introspect()`, and the final public names.
