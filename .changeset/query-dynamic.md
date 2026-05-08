---
"@nicia-ai/typegraph": minor
---

Add `fromDynamic` / `traverseDynamic` / `optionalTraverseDynamic` / `toDynamic` for string-keyed query traversals over runtime-declared kinds.

`store.query()` requires every `from` / `traverse` / `to` kind to be a compile-time literal in the graph definition, so kinds added at runtime via `defineGraphExtension` + `store.evolve` were unreachable through the typed builder — multi-hop traversals over agent-induced kinds previously needed `as any` casts or restructuring into separate `find` + manual joins.

The new sibling methods on the existing `store.query()` builder accept arbitrary string kinds:

```ts
const rows = await store
  .query()
  .from("Document", "d")              // typed alias - schema known
  .traverseDynamic("taggedWith", "e") // runtime edge
  .toDynamic("Tag", "n")              // runtime target
  .whereNode("d", (d) => d.title.eq("the doc"))             // typed: direct accessor
  .whereNode("n", (n) => n.field("label").string().eq("research")) // dynamic: discriminator
  .select((ctx) => ({ doc: ctx.d, tag: ctx.n }))
  .execute();
```

`optionalTraverseDynamic` is the LEFT-JOIN sibling — source nodes without a matching edge still surface, with the dynamic edge and target aliases as `undefined`.

Each dynamic method validates against the registry at runtime: `KindNotFoundError` on unknown node or edge names, and `EndpointError` when a `toDynamic` target isn't a valid endpoint for the current edge / direction. So `fromDynamic("Ppaer", ...)` and `traverseDynamic("authoredBy") + toDynamic("Document", ...)` (when `authoredBy.to=[Author]`) both fail fast instead of silently producing an empty query.

Predicate accessors on dynamic aliases use a `.field(name)` discriminator that returns a `DynamicFieldBuilder`. Type-specific predicates sit behind `.string()` / `.number()` / `.date()` / `.array()` / `.object()` / `.embedding()` — each validates against the registered Zod schema at query-build time and throws `TypeError` on mismatch. `BaseFieldAccessor` methods (`eq`, `isNull`, etc.) are available directly without a discriminator.

Mixed queries are first-class: typed aliases keep their existing typed accessors, dynamic aliases get the `.field()` API. The conditional accessor types (`NodeAccessor<N>` / `EdgeAccessor<E>` / `SelectableNode<N>` / `SelectableEdge<E>`) branch per alias on a phantom brand carried by `DynamicNodeType` / `DynamicEdgeType`. A typed `traverse("typedEdge", "e")` followed by `.toDynamic(target, "n")` keeps `e` typed — the edge schema flows through `EdgeTypeForKey<G, EK>`, not erased to `AnyEdgeType` — so `e.role.eq(...)` works without a discriminator while only the dynamic-declared aliases go through `.field()`.

New exported types: `DynamicNodeAccessor`, `DynamicEdgeAccessor`, `DynamicFieldBuilder`, `DynamicSelectableNode`, `DynamicSelectableEdge`, `DynamicNodeType`, `DynamicEdgeType`. The compile-time `store.query()` surface is unchanged — `store.query().from("UnknownKind", ...)` still produces a TypeScript error.
