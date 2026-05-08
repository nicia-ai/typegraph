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
- `store.introspect()` returns the merged schema (`kinds`, `edges`, `ontology`), the persisted extension document on `extension`, the soft-deprecation set on `deprecatedKinds`, and the active schema version and hash on `schemaVersion` / `schemaHash` (both `undefined` until the first commit).
- `store.materializeIndexes()` materializes compile-time and graph-extension relational/vector indexes per deployment.
- `store.deprecateKinds()`, `store.undeprecateKinds()`, `store.removeKinds()`, and `store.materializeRemovals()` manage graph-extension-kind lifecycle after induction.

The v1 document subset supports nodes, edges, ontology relations, annotations, unique constraints, relational indexes, searchable string fields, and embedding fields. Restart parity is load-bearing: `createStoreWithSchema()` reads `schema_doc.extension`, recompiles the extension, and rebuilds the same Zod-bearing merged graph in a fresh process.

`validateGraphExtension(input, { strict: true })` and `defineGraphExtension(input)` reject unknown sibling keys at every property level, surfacing the new `UNKNOWN_PROPERTY_KEY` issue. A typo like `minLenght: 5` on a string property would otherwise compile silently to a constraint-less schema; the strict path catches it at the LLM/agent trust boundary. The persistence-load path stays loose so a future v1.x.y writer's additive refinements still parse on an older v1 reader.

Published package exports now expose declarations through a first-class `types` condition so packed-artifact consumers resolve `@nicia-ai/typegraph` and subpath types correctly.
