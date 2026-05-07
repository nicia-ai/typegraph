---
"@nicia-ai/typegraph": minor
---

Ship graph extensions for agent-driven schema induction.

Graph extensions let a running application accept a reviewed, JSON-serializable schema proposal and commit it as a durable TypeGraph schema version without redeploying application code.

Public API:

- `defineGraphExtension(input)` and `validateGraphExtension(input, options?)` build and validate pure graph-extension documents.
- `GraphExtension`, `ExtensionNodeDef`, `ExtensionEdgeDef`, `ExtensionPropertyType`, `ExtensionIndex`, version constants, and graph-extension error classes are exported for tool builders.
- `Store.evolve(extension, { ref?, eager? })` atomically commits the merged schema with CAS and returns a fresh store carrying the runtime-declared kinds.
- Runtime-declared kinds are reached through `getNodeCollection(kind)`, `getNodeCollectionOrThrow(kind)`, `getEdgeCollection(kind)`, and `getEdgeCollectionOrThrow(kind)`.
- `store.introspect()` returns the merged schema, origin markers, persisted extension, deprecation set, and known schema version/hash.
- `store.materializeIndexes()` materializes compile-time and graph-extension relational/vector indexes per deployment.
- `store.deprecateKinds()`, `store.undeprecateKinds()`, `store.removeKinds()`, and `store.materializeRemovals()` manage runtime-kind lifecycle after induction.

The v1 document subset supports nodes, edges, ontology relations, annotations, unique constraints, relational indexes, searchable string fields, and embedding fields. Restart parity is load-bearing: `createStoreWithSchema()` reads `schema_doc.extension`, recompiles the extension, and rebuilds the same Zod-bearing merged graph in a fresh process.

The final public naming is `defineGraphExtension`, not the earlier pre-release `defineRuntimeExtension` draft. The value being defined is a graph-extension document; the runtime action is `store.evolve()`.

This release also tightens release-blocking validation and DX gaps:

- Missing index `fields` now fails at authoring time with `EMPTY_INDEX_FIELDS`.
- Duplicate runtime index names across separate evolves are rejected before persistence.
- Runtime index names are checked against compile-time index names on the merged graph.
- `store.introspect().schemaVersion` and `schemaHash` are preserved across `createStoreWithSchema()`, `evolve()`, deprecation updates, and removals.
- Published package exports now expose declarations through a first-class `types` condition so packed-artifact consumers resolve `@nicia-ai/typegraph` and subpath types correctly.
- The guide and runnable example now document extension-declared relational indexes, kind removal, deprecation through `introspect()`, and the final public names.
