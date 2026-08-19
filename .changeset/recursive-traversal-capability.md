---
"@nicia-ai/typegraph": minor
---

`BackendCapabilities` gains an optional `recursiveTraversal` field describing whether the engine can compute a bounded transitive closure of a relation in one round trip — a recursive CTE on a SQL engine, or a graph-native expansion operator elsewhere. Absent means supported, so every existing backend that never declared the field is unaffected; a backend that genuinely lacks the primitive declares `{ supported: false, reason }`.

The decision is resolved through a branded `RecursiveTraversalVerdict` that only `resolveRecursiveTraversal` can construct, so a caller cannot forge one by writing `{ supported: true }` inline. Also exported: `assumeRecursiveTraversalSupported` (the one sanctioned way to obtain a verdict without a backend, used by the query compiler's no-backend entry point), `assertRecursiveTraversal`, `recursiveTraversalUnsupportedError`, and the `RecursiveTraversalCapability` type itself.

All six `WITH RECURSIVE` emission sites now consult the resolved verdict — four builder inputs require it, the compiler option defaults it when compiling without a backend, and the weighted extractor resolves it internally off the backend's capabilities. Five refuse when the verdict says unsupported, throwing `ConfigurationError` with code `RECURSIVE_TRAVERSAL_UNSUPPORTED` and `details.operation` naming the refusing site: variable-length (`traverse`) queries, `store.subgraph()`, historical identity class reads, identity-expanded historical queries, and the identity window-ledger read. The sixth, weighted shortest path, does not refuse — it gains a predecessor-walk fallback that returns the identical path in `pathLength + 1` extraction statements when the backend has no recursion but does support temporary statements.

`CompileQueryOptions` gains an optional `recursiveTraversal`, threaded by `propagateOptions` into every set-operation sub-compile so a `union()`/`intersect()`/`except()` operand carries the same verdict as its parent query.

The two bundled factories now refuse a contradictory capability declaration at construction — `supported: false` with no `reason`, or `supported: true` with a dangling `reason` — with `ConfigurationError` code `CAPABILITY_DECLARATION_CONTRADICTION`. This also applies to a caller-supplied `capabilities` override on either factory.

One behavior note for custom backends: a backend-owned clone of the factory-assembled `capabilities` object is now deep-frozen, so code that mutated `backend.capabilities` (or a nested field such as `backend.capabilities.vector`) after construction now throws instead of silently succeeding. Objects supplied through the factory options remain caller-owned and mutable.

The bundled SQLite and PostgreSQL backends both declare `{ supported: true }`, so no shipped configuration changes behavior — this release only adds the capability, the refusal, and the fallback for backends that opt into declaring recursion absent.
