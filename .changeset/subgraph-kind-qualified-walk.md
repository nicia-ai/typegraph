---
"@nicia-ai/typegraph": minor
---

Fix `store.subgraph()` for graphs where nodes of different kinds share an id. The root is now a `{ kind, id }` reference, and the result is keyed by (kind, id).

Node rows are keyed by (kind, id), but `subgraph()` treated a node's id alone as its identity: it seeded the walk by bare id, stepped along every edge whose endpoint id matched without checking the endpoint kind, hydrated every node whose id was in the walk, and keyed its result by id. So with `Show:a → Clip:m → Show:m → Clip:z`, `Clip:m` was reached but replaced by `Show:m` in `nodes`; with `Show:b → Clip:x` and an unconnected `Show:x → Show:y`, the walk from `b` followed `Show:x`'s edges and returned `Show:x` and `Show:y`; and an unconnected `Clip:a` could make `subgraph("a").root` resolve to `Clip:a` instead of `Show:a`.

The walk is now keyed on (kind, id) everywhere: the seed, each recursive step in both directions and through `edgeWindows`, cycle detection, the nodes it returns, and the edges it keeps. This applies to direct, transaction, `batchOnce()` (including `shareSubgraphs: true`), `store.asOf()`, and `store.asOfRecorded()` reads. A walk that reaches two same-id nodes of different kinds returns both, each under its own kind, including folded peers on a graph with `identity: { sameIdAcrossKinds: "fold" }` (the walk follows edges, not identity classes). The PostgreSQL step join now uses the leading `(graph_id, from_kind, from_id)` columns of the edge traversal indexes.

`store.batchOnce()` no longer overflows the call stack while composing a batch near its 500-read cap. A batch of 500 subgraph reads used to throw `RangeError: Maximum call stack size exceeded` instead of running.

### Breaking

- `subgraph(root, options)` takes a `{ kind, id }` reference (`GraphNodeReference<G>`) instead of a node id, on `store`, transactions, `batchOnce()` reads, and `store.asOf()` / `store.asOfRecorded()` views. Pass the node itself (`store.subgraph(run, …)`) or `{ kind: "Run", id: runId }`. A bare id now throws `ValidationError`, and an unregistered kind throws `KindNotFoundError`.
- `SubgraphResult` replaces its id-keyed maps with plain arrays, `{ root, nodes, edges }`, and (kind, id) lookups move to the new `indexSubgraph(result)` helper, which returns `{ node, outgoing, incoming }`. The result stays plain data, so it still survives `structuredClone`, `postMessage`, and React Server Component props.

  | Before | After |
  | --- | --- |
  | `nodes: ReadonlyMap<id, node>` | `nodes: readonly node[]` (ordered by kind, then id) |
  | `nodes.get(id)` / `nodes.has(id)` | `indexSubgraph(sg).node({ kind, id })` / `… !== undefined` |
  | `nodes.size`, `nodes.values()` | `nodes.length`, `nodes` |
  | `adjacency.get(fromId)?.get(edgeKind)` | `indexSubgraph(sg).outgoing({ kind, id }, edgeKind)` |
  | `reverseAdjacency.get(toId)?.get(edgeKind)` | `indexSubgraph(sg).incoming({ kind, id }, edgeKind)` |
  | iterating `adjacency` for every edge | `edges` (ordered by id) |

  Every lookup takes a `{ kind, id }` key, so following an edge is `node({ kind: edge.toKind, id: edge.toId })`; a literal kind narrows the returned node and must be a kind the result can hold. `indexSubgraph`, `SubgraphIndex`, `SubgraphNodeKey`, `SubgraphEdgeKey`, `SubgraphNodeLookup`, `SubgraphEdgeLookup`, and `SubgraphKindSelection` are exported.
