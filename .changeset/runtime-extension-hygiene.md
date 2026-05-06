---
"@nicia-ai/typegraph": minor
---

1.0 hygiene pass on the runtime-extension surface from #101.

## Public API narrowing

Removed two internal helpers from the root export (`@nicia-ai/typegraph`). They remain available via the deep import `@nicia-ai/typegraph/runtime` for tests and library-internal callers, but are no longer part of the consumer-facing API:

- `compileRuntimeExtension` — the value→Zod compiler that turns a `RuntimeGraphDocument` into a compiled schema. The compiler runs implicitly inside `Store.evolve()` and inside the schema loader on restart; consumers never need to call it directly.
- `mergeRuntimeExtension` — folds a runtime extension document into a `GraphDef`. Only meaningful inside `Store.evolve()` and `loadAndMergeRuntimeDocument`; consumers never call it directly.

Consumer-facing surface stays as it was: `defineRuntimeExtension`, `validateRuntimeExtension`, `RuntimeExtensionValidationError`, the `RuntimeGraphDocument` type, `Store.evolve()`, `Store.materializeIndexes()`, `Store.deprecateKinds()` / `undeprecateKinds()`, `Store.deprecatedKinds`, `StoreRef<T>`, and `applyDeprecatedKinds` (advanced).

## Hash invariance: `annotations: {}` no longer bumps the hash

Before this change, declaring a kind with `annotations: {}` (an empty object) produced a different schema hash than omitting `annotations` entirely. This was an asymmetry against the rule applied to `indexes` (where `[]` and absent both omit-when-empty so legacy graphs hash byte-identically with new graphs that opt into the slice).

Annotations now follow the same omit-when-empty rule:

- Absent annotations → omitted from canonical form.
- `annotations: undefined` → omitted from canonical form.
- `annotations: {}` → omitted from canonical form.
- `annotations: { ui: "hidden" }` (non-empty) → included.

Net effect: `{}` is now hash-equivalent to absent, eliminating a footgun for codegen / spread-based builders that may emit `annotations: {}` even when the consumer declared no annotations.

This is a one-time hash change for any deployed graph that has stored a schema with `annotations: {}` in the `schema_doc`. On the next `ensureSchema()` call, the change will surface as a structural diff (annotations classification → no actual change in semantics, since both empty and absent mean "no annotations"). Pre-1.0 acceptable.
