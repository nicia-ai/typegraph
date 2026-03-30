---
"@nicia-ai/typegraph": minor
---

Add `store.getNodeCollection(kind)` and `store.getEdgeCollection(kind)` methods for runtime string-keyed collection access. Returns the full collection API with widened generics (`DynamicNodeCollection` / `DynamicEdgeCollection`), or `undefined` if the kind is not registered. Eliminates the need for `Reflect.get(store.nodes, kind) as SomeType` patterns when iterating kinds, resolving nodes from edge metadata, or building generic graph tooling like snapshots and summaries.
