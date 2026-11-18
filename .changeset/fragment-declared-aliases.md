---
"@nicia-ai/typegraph": minor
---

`createFragment()` fragments now declare the node aliases they require, so a fragment written away from its query type-checks and composes. `fragment({ u: "User" }, (q) => q.whereNode("u", ({ status }) => status.eq("active")))` types its body against a builder holding only `u`, as `from("User", "u")` types it. Piped into a query, the fragment keeps every node, edge and recursive alias that query carries, with its exact type, and adds the aliases its body adds, so an alias-adding fragment (`q.traverse("authored", "a", { from: "u" }).to("Post", "p")`) exposes `ctx.p` and `ctx.a` after the pipe. A fragment that requires no alias takes only its body: `fragment((q) => q.limit(10))`.

`pipe()` is a compile error, with a message naming the alias, when the query lacks a required alias, binds it at another kind (a list source, an untyped `expansion: "narrower"` or `fromDynamic()` alias, or a different kind), or already uses an alias the fragment adds; a fragment never shadows a host alias. A caller the compile-time check cannot reach is refused at runtime with a `ConfigurationError` coded `QUERY_FRAGMENT_REQUIREMENT_UNMET`; the runtime check admits a host alias bound to a subclass of the declared kind. `composeFragments()` takes declared fragments and computes the composition's requirements, so a later fragment may require an alias an earlier one adds, and a conflicting requirement or a repeated added alias is a compile error at the `composeFragments()` call.

### Breaking

`createFragment()`'s fragment factory takes the required aliases as its first argument. A fragment that used explicit type arguments for its input and output alias maps now states the aliases it requires:

```typescript
// Before
const activeOnly = createFragment<typeof graph>()<
  Readonly<{ u: NodeAlias<typeof User> }>,
  Readonly<{ u: NodeAlias<typeof User> }>,
  EmptyEdgeAliasMap,
  EmptyEdgeAliasMap
>((q) => q.whereNode("u", ({ status }) => status.eq("active")));

// After
const activeOnly = createFragment<typeof graph>()({ u: "User" }, (q) =>
  q.whereNode("u", ({ status }) => status.eq("active")),
);
```

`QueryFragment` changed shape: it was `QueryFragment<G, InAliases, OutAliases, InEdgeAliases, OutEdgeAliases, InRecursiveAliases, OutRecursiveAliases>`, a plain function type, and is now `QueryFragment<G, Requires, Added, AddedEdges, AddedRecursive>`, the type `createFragment()` returns. A hand-written function annotated as `QueryFragment` is no longer one; build it with `createFragment()`, or pass it to `pipe()` inline. `composeFragments()` takes `createFragment()` fragments (and the helper fragments), not bare functions.

`FlexibleQueryFragment` is removed: `QueryFragment` is generic over the host query in the same way and also refuses alias collisions. `limitFragment()`, `offsetFragment()` and `orderByFragment()` now return `QueryFragment<G>`.

New exported types: `FragmentRequirements`, `FragmentRequiredAliases`, `QueryFragmentBody` and `QueryFragmentFactory`.
