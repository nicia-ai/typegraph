---
"@nicia-ai/typegraph": minor
---

**BREAKING:** `store.subgraph()` now returns an indexed result instead of flat arrays.

The result shape changes from `{ nodes: Node[], edges: Edge[] }` to:

```typescript
{
  root: Node | undefined;
  nodes: ReadonlyMap<string, Node>;
  adjacency: ReadonlyMap<string, ReadonlyMap<EdgeKind, Edge[]>>;
  reverseAdjacency: ReadonlyMap<string, ReadonlyMap<EdgeKind, Edge[]>>;
}
```

This eliminates the indexing boilerplate every consumer had to write before traversing the subgraph. Nodes are keyed by ID for O(1) lookup, and edges are organized into forward/reverse adjacency maps keyed by `nodeId → edgeKind`.

Migration:
- `result.nodes` is now a `Map` — use `.size` instead of `.length`, `.values()` instead of direct iteration, `.has(id)` / `.get(id)` instead of `.find()`
- `result.edges` is removed — access edges via `result.adjacency.get(fromId)?.get(edgeKind)` or `result.reverseAdjacency.get(toId)?.get(edgeKind)`
- `result.root` provides the root node directly (no lookup needed)
