---
"@nicia-ai/typegraph": minor
---

Add `getNodePropsSchema` / `getEdgePropsSchema` (plus `…OrThrow` siblings) on `Store` for runtime access to the compiled Zod props schema.

Compile-time and graph-extension kinds both store their props schema as a real `z.ZodObject` — `defineNode` / `defineEdge` for the typed surface, `compileGraphExtension` for the runtime surface — and the store validates `.create()` / `.update()` against those objects. Until now those Zod instances weren't reachable through the public API, so MCP servers, tool wrappers, and agent loops that wanted to validate inputs with the same schema as the store had to either reach into private fields or round-trip `introspect().properties` JSON Schema → Zod (lossy on refinements, formats, branded `searchable()` / `embedding()` types).

The new accessors return the exact Zod object the store uses. Closes #122.

```ts
const schema = store.getNodePropsSchemaOrThrow("Paper");
const parsed = schema.parse(input);            // same parsed output as papers.create(input)
const json = z.toJSONSchema(schema);            // for MCP tool descriptions / agent prompts
```

Lookup is `Object.hasOwn`-gated, matching `getNodeCollection` / `getEdgeCollection` (no prototype-name leakage). The `OrThrow` variants throw `KindNotFoundError` on unknown kinds. Identity holds for compile-time kinds: `store.getNodePropsSchema("Person") === Person.schema`.

These return only the props validator. Operation-level checks — uniqueness, endpoint resolution (edges validate endpoints before props), temporal validity, backend constraints — still run only through `collection.create` / `update`. Failed `parse()` throws `ZodError`; failed `create()` wraps the same underlying issues in `ValidationError`.
