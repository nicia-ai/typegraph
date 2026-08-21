---
"@nicia-ai/typegraph": minor
---

Custom backends can now declare whether they support recursive traversal with `capabilities.recursiveTraversal`. Absence means supported for backward compatibility; an engine without recursive SQL or a graph-native equivalent declares `{ supported: false, reason }`.

The decision is resolved through a branded `RecursiveTraversalVerdict` that only `resolveRecursiveTraversal` can construct, so a caller cannot forge one by writing `{ supported: true }` inline. Also exported: `assumeRecursiveTraversalSupported` (the one sanctioned way to obtain a verdict without a backend, used by the query compiler's no-backend entry point), `assertRecursiveTraversal`, `recursiveTraversalUnsupportedError`, and the `RecursiveTraversalCapability` type itself.

Variable-length queries, `store.subgraph()`, and the three recursion-dependent historical identity reads now refuse an unsupported declaration with `ConfigurationError` code `RECURSIVE_TRAVERSAL_UNSUPPORTED`; `details.operation` and `details.reason` identify the affected path and engine limitation. `weightedShortestPath` keeps working when temporary statements are available, reconstructing the same path through `pathLength + 1` predecessor reads instead of one recursive extraction statement.

`CompileQueryOptions` gains an optional `recursiveTraversal`, threaded by `propagateOptions` into every set-operation sub-compile so a `union()`/`intersect()`/`except()` operand carries the same verdict as its parent query.

Bundled factories refuse contradictory declarations — unsupported without a reason or supported with a dangling reason — using `CAPABILITY_DECLARATION_CONTRADICTION`. The bundled SQLite and PostgreSQL backends declare support, so their query behavior is unchanged.

Custom backend note: the factory-owned clone of `backend.capabilities` is now deep-frozen, so mutating it after construction throws. Objects supplied through factory options remain caller-owned and mutable. See [Recursive traversal capability](https://typegraph.dev/backend-setup#recursive-traversal-capability) and the [recursive query guide](https://typegraph.dev/queries/recursive#backend-support).
