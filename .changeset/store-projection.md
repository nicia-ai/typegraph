---
"@nicia-ai/typegraph": minor
---

Add `StoreProjection<G, N, E>` utility type for typing reusable helpers that work across graphs sharing a common subgraph. The type projects a store's collection surface onto a subset of node and edge keys, with node constraint names erased so that graphs registering the same node types with different unique constraints remain cross-assignable. Both `Store<G>` and `TransactionContext<G>` are structurally assignable to any `StoreProjection` whose keys are a subset of `G`. Also exports `GraphNodeCollections<G>` and `GraphEdgeCollections<G>` shared mapped types.
