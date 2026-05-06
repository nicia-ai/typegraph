---
"@nicia-ai/typegraph": minor
---

Bring compile-time indexes into `defineGraph` and `SerializedSchema` so they flow through the canonical schema document uniformly with future runtime-declared indexes.

```typescript
const personEmail = defineNodeIndex(Person, {
  fields: ["email"],
  unique: true,
});

const graph = defineGraph({
  id: "social",
  nodes: { Person: { type: Person } },
  edges: {},
  indexes: [personEmail],
});

// graph.indexes is readonly IndexDeclaration[] — JSON-serializable,
// flows into SerializedSchema.indexes, ready for materialization.
```

**Public API additions:**

- `defineNodeIndex`, `defineEdgeIndex`, `andWhere`, `orWhere`, and `notWhere` now ship from the main `@nicia-ai/typegraph` entry point. The `@nicia-ai/typegraph/indexes` subpath remains for advanced consumers (Drizzle schema integration, `generateIndexDDL`, `toDeclaredIndex` for the profiler).
- `defineNodeIndex` / `defineEdgeIndex` now return `NodeIndexDeclaration` / `EdgeIndexDeclaration` directly — the same JSON-serializable shape that flows through `SerializedSchema.indexes`. There is no separate "live" index value; the previous `NodeIndex` / `EdgeIndex` / `TypeGraphIndex` types and the `toIndexDeclaration` adapter have been removed.
- `defineGraph({ ..., indexes: [...] })` accepts those declarations directly (whether produced by the typed builders or reconstructed from a stored schema document). Validated at definition time: every index must reference a registered `kind`, and index `name`s must be unique within a graph. Throws `ConfigurationError` otherwise.
- New types: `IndexDeclaration` (discriminated union of `NodeIndexDeclaration` / `EdgeIndexDeclaration`), `IndexOrigin`.

**`SerializedSchema.indexes` slice.** Each entry carries an `origin?: "compile-time" | "runtime"` discriminator so a runtime extension loader can route declarations through the runtime compiler. Index DDL generation (`generateIndexDDL`, the Drizzle schema factories, the profiler `toDeclaredIndex` adapter) all read from this single canonical form — no parallel paths.

**Diffing.** `computeSchemaDiff` / `SchemaManager.getSchemaChanges` now classify index additions, removals, and modifications. All index changes are `safe`-severity: index DDL is materialized separately and never blocks schema-version commits.

**Load-bearing canonical-form invariants** (verified by tests in `tests/property/schema-serialization.test.ts`):

- Graphs that never declare indexes produce identical canonical-form hashes to today — adoption requires no migration.
- The serialized slice is order-canonicalized (sorted by `name`) and treats `undefined` and `[]` as the same "no slice" form. Indexes are an unordered set keyed by name; an empty list carries no semantic meaning that an absent slice doesn't, so the hash and the diff agree on both points (reorders are a no-op, opting in with `[]` doesn't bump the hash). The in-memory `GraphDef.indexes` still preserves whatever the caller passed for introspection.
- A populated `indexes` array bumps the hash. Round-trip (`serialize → JSON → serializedSchemaZod.parse → JSON`) is byte-identical after the canonical sort.
- `origin: "compile-time"` is the default and is omitted from canonical form. Only `origin: "runtime"` is emitted explicitly. Absence-as-default keeps compile-only graphs hashing identically while leaving the discriminator ready for runtime extensions.

**Forward compatibility.** `serializedSchemaZod` parses both old (no `indexes`) and new documents, with extras-allowed (`.loose()`) on each declaration so future fields don't break older readers.
