---
"@nicia-ai/typegraph": minor
---

Fix `store.subgraph()` for graphs where nodes of different kinds share an id, and accept a `{ kind, id }` reference as its root.

Node rows are keyed by (kind, id), but `subgraph()` treated a node's id alone as its identity: it seeded the walk by bare id, stepped along every edge whose endpoint id matched without checking the endpoint kind, and hydrated every node whose id was in the walk. So with `Show:a → Clip:m → Show:m → Clip:z`, `Clip:m` was reached but replaced by `Show:m` in the id-keyed `nodes` map; with `Show:b → Clip:x` and an unconnected `Show:x → Show:y`, the walk from `b` followed `Show:x`'s edges and returned `Show:x` and `Show:y`; and an unconnected `Clip:a` could make `subgraph("a").root` resolve to `Clip:a` instead of `Show:a`.

The walk is now keyed on (kind, id) everywhere: the seed, each recursive step in both directions, cycle detection, the nodes it returns, and the edges it keeps. This applies to direct, transaction, `batchOnce()` (including `shareSubgraphs: true`), `store.asOf()`, and `store.asOfRecorded()` reads.

`subgraph(root, options)` now accepts `root` as a `{ kind, id }` reference (`SubgraphRoot<G>`, exported) as well as a bare node id. A reference with an unregistered kind throws `KindNotFoundError`. A bare id resolves to the one kind holding it visibly at the read's temporal coordinate; when several kinds hold it, the read throws the new `SubgraphAmbiguousNodeIdError` with `details.situation: "root"`.

The result keeps its id-keyed shape. When the root and the nodes a read returns would share an id across kinds, the read throws `SubgraphAmbiguousNodeIdError` with `details.situation: "result"` (code `SUBGRAPH_AMBIGUOUS_NODE_ID`, with `details.id` and `details.kinds`) instead of returning a map where one node silently replaced another. The root counts even when `excludeRoot` drops it or `includeKinds` omits its kind. Graphs whose ids never repeat across kinds, including every graph using generated ids, see no change in results.

### Breaking

- `defineNode()` and `defineGraph()` now reject a node kind name containing U+001F (unit separator) with a `ConfigurationError`, the same way they already reject U+001E. Recursive walks key their cycle-detection tokens as `kind + U+001F + id`, so such a kind could make two distinct nodes spell one token and drop the second as a revisit. Rename any such kind before upgrading.
