---
"@nicia-ai/typegraph": minor
---

Add `defineRuntimeExtension(...)` and `compileRuntimeExtension(...)` — a TypeGraph-native runtime graph document and a one-way compiler that turns it into Zod-bearing `NodeType` / `EdgeType` / `OntologyRelation` values. This is the value-layer foundation of the runtime-extension feature (issue #101 PR 3/6); persistence (`SerializedSchema.runtimeDocument`), the loader rewire, and `store.evolve()` land in PRs 4 and 5.

```typescript
import {
  compileRuntimeExtension,
  defineRuntimeExtension,
} from "@nicia-ai/typegraph";

const document = defineRuntimeExtension({
  nodes: {
    Paper: {
      properties: {
        doi: { type: "string" },
        title: { type: "string", searchable: { language: "english" } },
        abstract: {
          type: "string",
          searchable: { language: "english" },
          optional: true,
        },
        publishedAt: { type: "string", format: "datetime" },
        publicationType: {
          type: "enum",
          values: ["preprint", "conference", "journal", "workshop"],
        },
      },
      unique: [{ name: "paper_doi", fields: ["doi"] }],
    },
    Author: {
      properties: { name: { type: "string", minLength: 1 } },
    },
  },
  edges: {
    authoredBy: { from: ["Paper"], to: ["Author"], properties: {} },
  },
});

const compiled = compileRuntimeExtension(document);
// compiled.nodes[*].type is a NodeType, structurally indistinguishable from
// the equivalent hand-written `defineNode(...)`.
```

**Why a TypeGraph-native document and not JSON Schema → Zod.** The existing `Zod → JSON Schema` path is one-way (`schema/deserializer.ts:5` documents the constraint). Running the loop in the other direction would lose `searchable()` markers, the `embedding()` brand, `.optional()` shape, and unique-constraint extraction — exactly the metadata the rest of TypeGraph reads at runtime. Owning both ends of the document → Zod path keeps the round-trip lossless. The runtime document is the canonical durable form; Zod is derived on each load. PR 4 will persist this document; PR 5 will let `store.evolve()` commit one and rebuild a `Store<ExtendedGraph>`.

**v1 property-type subset is intentionally narrow** — it covers what LLM-induced schemas actually emit and nothing more. Anything outside the set fails synchronously at `defineRuntimeExtension(...)` with a JSON-pointer path to the offending node.

| Type | Refinements |
|---|---|
| `string` | `minLength`, `maxLength`, `pattern`, `format: "datetime" \| "uri"` |
| `number` | `min`, `max`, `int` |
| `boolean` | — |
| `enum` | `values: readonly string[]` |
| `array` | `items: <any of these types>` (no nested arrays) |
| `object` | `properties: { ... }` (single nesting level) |

Plus per-property `optional`, `searchable: { language? }`, `embedding: { dimensions }`, and per-kind `unique: [{ name, fields, scope?, collation?, where? }]` where `where` is limited to `isNull` / `isNotNull` (matches the existing `serializeWherePredicate` capability). Adding refinements later is non-breaking; allowing the wrong shape now is forever.

**Modifier combinations the v1 compiler can't honor are rejected at validation**, with an `INVALID_PROPERTY_REFINEMENT` issue and a JSON-pointer path:

- `format` + `searchable` — the format-routed Zod schemas (`z.iso.datetime` / `z.url`) aren't `z.ZodString` and can't carry the searchable brand.
- `format` + `minLength` / `maxLength` / `pattern` — same shape limitation; mixing them silently dropped the refinements before this fix.
- `embedding` + item refinements — `embedding(dimensions)` replaces the array's item validator, so any `min` / `max` / `int` on the items would silently disappear.

**Edge endpoints can reference unresolved kinds.** Endpoint names that don't match a kind declared in this same document are preserved as raw strings on `CompiledEdge.from` / `to` (typed `(NodeType | string)[]`) so the host-graph merge step can resolve them against compile-time kinds or treat them as external IRIs. Cross-graph resolution is intentionally out of scope for this PR.

**Hierarchical-cycle detection normalizes inverse meta-edges before checking**, mirroring the registry's relation flattening: `narrower A→B` and `hasPart A→B` are treated as `broader B→A` and `partOf B→A` respectively. Mixed-direction cycles (e.g. `broader A→B` + `narrower A→B`) are now caught at validation instead of slipping through to runtime.

**Round-trip parity is the load-bearing invariant.** For every type and modifier in the v1 subset, the test suite declares the same kind two ways — hand-written via `defineNode` / `defineEdge` and document-via-`defineRuntimeExtension` — and asserts that downstream introspection (`getSearchableMetadata`, `getEmbeddingDimensions`, unique-constraint extraction) returns identical results, that valid inputs parse to the same value, and that invalid inputs reject with the same issue paths. Property tests over the type subset further generate arbitrary documents and assert the compile pipeline always produces a Zod schema that accepts the document's own example values.

**Two `validateRuntimeExtension` shapes.** Consumers that prefer `Result`-style get `validateRuntimeExtension(input)` returning `Result<RuntimeGraphDocument, RuntimeExtensionValidationError>`. The throw-on-error variant `defineRuntimeExtension(input)` is a thin wrapper that unwraps. Errors carry a structured `issues` array with stable `RuntimeExtensionIssueCode` values and JSON-pointer paths so callers can render field-level diagnostics without parsing message text.

**Out of scope for this PR.** No `store.evolve()`. No `SerializedSchema` changes. No persistence. No DDL. No backend touches. The compiled output is a pure value the next PR will merge into a `GraphDef`.

Closes part of #101.
