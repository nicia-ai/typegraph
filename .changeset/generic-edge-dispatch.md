---
"@nicia-ai/typegraph": minor
---

Support generic edge dispatch through `DynamicEdgeCollection<E>` and graph-aware dynamic lookups. Edge property and result types are preserved while endpoint pairs are validated at runtime. Transactions now expose `getEdgeCollection` and `getEdgeCollectionOrThrow`, including scoped receipt accounting; valid-time views expose pinned dynamic edge reads.

Migration: replace generic `tx.edges[kind]` calls or uncorrelated collection casts with `tx.getEdgeCollectionOrThrow(kind)`. Concrete `.edges.<kind>` calls retain compile-time pair checking. Known-kind dynamic lookups now enforce their property schema at compile time; parse unvalidated records before passing them. Broad `EdgeRegistration` annotations continue to permit array or map targets; narrow the target shape when inspecting it. Hand-authored transaction and view mocks must provide the new lookup methods.

Fix outgoing traversal target inference in graph factories that accept generic node types. Preserve the declared target kinds for both array targets and source-dependent maps, including unions of edge kinds.
