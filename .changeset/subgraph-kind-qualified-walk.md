---
"@nicia-ai/typegraph": minor
---

Fix `store.subgraph()` for graphs where nodes of different kinds share an id. The root is now a `{ kind, id }` reference, and the result is keyed by (kind, id).

Node rows are keyed by (kind, id), but `subgraph()` treated a node's id alone as its identity: it seeded the walk by bare id, stepped along every edge whose endpoint id matched without checking the endpoint kind, hydrated every node whose id was in the walk, and keyed its result by id. So with `Show:a → Clip:m → Show:m → Clip:z`, `Clip:m` was reached but replaced by `Show:m` in `nodes`; with `Show:b → Clip:x` and an unconnected `Show:x → Show:y`, the walk from `b` followed `Show:x`'s edges and returned `Show:x` and `Show:y`; and an unconnected `Clip:a` could make `subgraph("a").root` resolve to `Clip:a` instead of `Show:a`.

The walk is now keyed on (kind, id) everywhere: the seed, each recursive step in both directions and through `edgeWindows`, cycle detection, the nodes it returns, and the edges it keeps. This applies to direct, transaction, `batchOnce()` (including `shareSubgraphs: true`), `store.asOf()`, and `store.asOfRecorded()` reads. A walk that reaches two same-id nodes of different kinds returns both, each under its own kind, including folded peers on a graph with `identity: { sameIdAcrossKinds: "fold" }` (the walk follows edges, not identity classes). The PostgreSQL step join now uses the leading `(graph_id, from_kind, from_id)` columns of the edge traversal indexes.

### Breaking

- `subgraph(root, options)` takes a `{ kind, id }` reference (`GraphNodeReference<G>`) instead of a node id, on `store`, transactions, `batchOnce()` reads, and `store.asOf()` / `store.asOfRecorded()` views. Pass the node itself (`store.subgraph(run, …)`) or `{ kind: "Run", id: runId }`. A bare id now throws `ValidationError`, and an unregistered kind throws `KindNotFoundError`.
- `SubgraphResult` replaces its id-keyed maps with arrays and (kind, id) lookups:

  | Before | After |
  | --- | --- |
  | `nodes: ReadonlyMap<id, node>` | `nodes: readonly node[]` (ordered by kind, then id) |
  | `nodes.get(id)` / `nodes.has(id)` | `node({ kind, id })` / `node({ kind, id }) !== undefined` |
  | `nodes.size`, `nodes.values()` | `nodes.length`, `nodes` |
  | `adjacency.get(fromId)?.get(edgeKind)` | `outgoing({ kind, id }, edgeKind)` |
  | `reverseAdjacency.get(toId)?.get(edgeKind)` | `incoming({ kind, id }, edgeKind)` |
  | iterating `adjacency` for every edge | `edges` (ordered by id) |

  Every lookup takes a `{ kind, id }` key, so following an edge is `sg.node({ kind: edge.toKind, id: edge.toId })`. The new `SubgraphNodeKey`, `SubgraphNodeLookup`, and `SubgraphEdgeLookup` types are exported. Results carry lookup functions, so compare `{ root, nodes, edges }` rather than whole results in tests.
- `defineNode()` and `defineGraph()` now reject a node kind name containing U+001F (unit separator) with a `ConfigurationError`, as they already reject U+001E. Recursive walks key their cycle-detection tokens as `kind + U+001F + id`, so such a kind could make two distinct nodes spell one token and drop the second as a revisit. Rename any such kind before upgrading.
