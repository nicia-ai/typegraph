---
"@nicia-ai/typegraph": patch
---

**`subgraph()` and the graph algorithms refuse a kind the graph does not register.** `edges` and `includeKinds` on `store.subgraph()` (and on `tx.subgraph()`, `batchOnce`'s `read.subgraph()` and a view's `subgraph()`), `edges` on every algorithm read including `degree`, and the `nodeKinds` scope of `labelPropagation`, `weaklyConnectedComponents` and `pageRank` were compiled straight into a kind filter, so an unregistered name from untyped code matched nothing and the read answered with an ordinary empty or incomplete result. Each now rejects with `KindNotFoundError`, as `neighbors()` and `bulkFindEdgesFrom()` / `bulkFindEdgesTo()` already did; all of them share one lookup.

### Breaking

- A read that named an unregistered kind and answered with an empty or incomplete result now rejects with `KindNotFoundError`. Correct the kind name, or catch the error where a read over a possibly-dropped kind was relied on to return nothing.
