---
"@nicia-ai/typegraph": minor
---

Add `store.deprecateKinds(names)` and `store.undeprecateKinds(names)` — the soft-deprecation signal for runtime extension's PR series. Library-owned per-graph kind set persisted in `schema_doc.deprecatedKinds`, surfaces in `store.deprecatedKinds` for introspection, does not affect reads, writes, or queries. Bumps the schema version like any other change. Originally folded into `store.evolve()` design; pulled into its own PR for review focus.

```typescript
const [store] = await createStoreWithSchema(graph, backend);

// Mark a kind as deprecated. Surfaces in introspection (codegen, UI
// tooling, lints) but reads/writes still work normally.
const evolved = await store.deprecateKinds(["LegacyDocument"]);
console.log([...evolved.deprecatedKinds]); // ["LegacyDocument"]

// Reverse it.
const restored = await evolved.undeprecateKinds(["LegacyDocument"]);

// Works on both compile-time and runtime kinds. The standard StoreRef
// re-binding pattern applies; pass `{ ref }` to be re-pointed
// atomically with the schema commit.
```

## Public API

- `Store.deprecateKinds(names: readonly string[], options?: { ref?: StoreRef<Store<G>> })` — async, atomically commits a new schema version with `names` added to the persisted set. Idempotent: re-deprecating an already-deprecated kind is a no-op (no version bump). Throws `ConfigurationError` (`code: "DEPRECATE_UNKNOWN_KIND"`) if any name doesn't match a known compile-time or runtime kind on the catchup-merged baseline.
- `Store.undeprecateKinds(names: readonly string[], options?)` — symmetric reverse.
- `Store.deprecatedKinds: ReadonlySet<string>` — getter for introspection.
- `SchemaDiff.deprecatedKinds?: DeprecatedKindsChange` — diff classification (always `safe`-severity); `added` / `removed` arrays carry the per-name deltas.
- `applyDeprecatedKinds(graph, names)` — exported from `@nicia-ai/typegraph/schema` for advanced consumers; same API the loader uses to fold persisted deprecations onto a fresh `GraphDef`.

## Storage

- New top-level slice on `SerializedSchema`: `deprecatedKinds?: readonly string[]` (sorted for canonical-form stability).
- Omitted entirely when empty so legacy schemas hash byte-identically to before this PR landed.
- Loader (`loadAndMergeRuntimeDocument`) applies the persisted set onto the merged graph alongside the runtime extension document.

## Bug fix included

`computeSchemaHash` was building its hashable subset by enumerating fields explicitly and was missing `runtimeDocument` and `deprecatedKinds`. For runtime extensions the missing field didn't matter in practice because the merged graph's `nodes` / `edges` always changed on `evolve()` — but for deprecation (which is metadata only), the missing `deprecatedKinds` slot meant the hash stayed identical and `ensureSchema` returned `unchanged` instead of migrating. Fixed: both slices are now part of the hashable subset, with the same omit-when-empty rule.

## Concurrency + multi-process safety

Same primitive as `Store.evolve()`: `commitSchemaVersion` CAS on the active version. Concurrent deprecate/evolve calls produce one winner; the loser surfaces `StaleVersionError` or `SchemaContentConflictError` from the commit primitive. The internal `#catchUpToStored` helper folds the persisted runtime document AND deprecated set into the local baseline before computing the next state, so a stale store's deprecate call doesn't trample another writer's runtime extension (the same auto-merge approach `evolve()` uses).

## Out of scope

- **Removal of runtime-declared kinds.** Deprecation is the soft-signal alternative; full runtime-kind removal remains its own future design.
- **Hard-blocking reads/writes on deprecated kinds.** Deprecation is informational; if consumers want to refuse operations on deprecated kinds, they wrap the collection access themselves.
