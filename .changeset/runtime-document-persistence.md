---
"@nicia-ai/typegraph": minor
---

Persist `RuntimeGraphDocument` in `SerializedSchema` and rewire the schema-aware loader (`createStoreWithSchema`) so a `Store` is built against a graph that already has the persisted runtime extension merged in. This is the durable-storage half of the runtime-extension feature (issue #101 PR 4/6); `store.evolve()` and `StoreRef` ship in PR 5, `materializeIndexes()` in PR 6.

```typescript
// Process A (PR 5 will turn this into store.evolve(...) — for PR 4 we
// invoke the pieces directly):
const merged = mergeRuntimeExtension(graph, runtimeExtension);
const evolvedSchema = serializeSchema(merged, activeVersion + 1);
await backend.commitSchemaVersion({
  graphId: graph.id,
  expected: { kind: "active", version: activeVersion },
  version: activeVersion + 1,
  schemaHash: await computeSchemaHash(evolvedSchema),
  schemaDoc: evolvedSchema,
});

// Process B (different process, possibly different machine), boots
// against the same backend with the original compile-time graph:
const [store] = await createStoreWithSchema(graph, backend);
// store.registry.hasNodeType("RuntimeKindFromExtensionA") === true
```

**The load-bearing constraint** (`schema/deserializer.ts:5`): the existing `Zod → JSON Schema` path is one-way, so `SerializedSchema.{nodes,edges,ontology}` cannot reconstruct runtime Zod validators on its own. The persisted `runtimeDocument` is the only durable source the loader uses to rebuild them — the merged maps remain useful for diff machinery and human-readable schema reporting but never for validator reconstruction.

**Public-API additions:**

- `GraphDef.runtimeDocument: RuntimeGraphDocument | undefined` — set by the loader (and by `store.evolve()` in PR 5), never by `defineGraph` directly. Serializes through to the canonical document so re-serializing the merged graph reproduces the same hash.
- `SerializedSchema.runtimeDocument?: RuntimeGraphDocument` — the persisted slice. Omitted on graphs that have never been runtime-extended; legacy schemas hash byte-identically.
- `mergeRuntimeExtension(graph, document)` — pure function: structurally validates the document, compiles it, validates that every edge endpoint resolves either to a runtime kind in the same document or to a compile-time kind in the host graph, throws `ConfigurationError` on collisions or unresolvable references (or `RuntimeExtensionValidationError` for malformed documents), and returns the merge applied to `graph`.
- `loadAndMergeRuntimeDocument(backend, graph)` — schema-layer helper that reads the active row, parses it, folds any persisted runtime extension into the supplied graph, and returns the merged graph alongside the prefetched row + parsed schema. The loader passes those through to `ensureSchema` via a new `preloaded` option so each Store boot pays for one `getActiveSchema` round trip and one `serializedSchemaZod` walk, not two.
- `loadActiveSchemaWithBootstrap(backend, graphId)` and `parseSerializedSchema(json)` — factored out of `ensureSchema` for the load-and-merge helper; both surface from `@nicia-ai/typegraph/schema`.
- `RuntimeDocumentChange` and `SchemaDiff.runtimeDocument` — the diff classifies runtime-document changes as `safe`-severity (v1 runtime extensions are additive only; per-kind effects already surface in the node/edge/ontology change arrays).

**Loader rewire.** `createStoreWithSchema` now reads the active schema row before constructing the `Store`. If the row's `runtimeDocument` is present, the loader compiles + merges it into the application's compile-time `GraphDef` and constructs the `Store` against the merged graph; `ensureSchema` then runs against the merged form. The prefetched row and parsed schema thread through a new `preloaded` option on `ensureSchema`, so legacy graphs (no runtime extension persisted) still pay for exactly one `getActiveSchema` round trip and one Zod parse at startup.

**Startup-conflict behavior.** If application code has been updated such that a compile-time kind referenced by `runtimeDocument` (via an edge endpoint) no longer exists, `mergeRuntimeExtension` throws `ConfigurationError` with `code: "RUNTIME_EXTENSION_UNRESOLVED_ENDPOINT"`. Operators handle this by reverting the application change or evolving the runtime extension to drop the reference. Ontology endpoints remain permissive (unresolved strings pass through as external IRIs, matching the existing runtime-compiler behavior).

**Load-bearing canonical-form invariants** (verified by tests in `tests/property/schema-serialization.test.ts` and `tests/runtime-document-persistence.test.ts`):

- Graphs that have never been runtime-extended produce identical canonical-form hashes to today — adoption requires no migration.
- A graph merged with a runtime extension serializes to a hash that round-trips: re-merging the same extension on top of the same compile-time graph in a different process yields the same hash, so `ensureSchema` returns `unchanged` on restart instead of triggering a spurious migration.
- The diff distinguishes "runtime document added" / "modified" / "removed" as a single `RuntimeDocumentChange` alongside the per-kind node/edge/ontology changes the merge produces.

**Forward compatibility.** `runtimeDocumentZod` uses `.loose()` on every nested object so future v2 property-type extensions don't fail older readers; the runtime/validation.ts validator is the authoritative shape check on the way back up.
