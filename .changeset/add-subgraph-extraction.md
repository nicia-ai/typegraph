---
"@nicia-ai/typegraph": minor
---

Add `store.subgraph()` for typed BFS neighborhood extraction from a root node.

Given a root node ID, traverses specified edge kinds using a recursive CTE and returns all reachable nodes and connecting edges as fully typed discriminated unions.

**Options:**
- `edges` — edge kinds to traverse (required)
- `maxDepth` — maximum traversal depth (default: 10)
- `direction` — `"out"` (default) or `"both"` for undirected traversal
- `includeKinds` — filter returned nodes to specific kinds (traversal still follows all reachable nodes)
- `excludeRoot` — omit the root node from results
- `cyclePolicy` — cycle detection strategy (default: `"prevent"`)

**Type utilities exported:**
- `AnyNode<G>` / `AnyEdge<G>` — discriminated unions of all node/edge runtime types in a graph
- `SubsetNode<G, K>` / `SubsetEdge<G, K>` — narrowed unions for a subset of kinds
- `SubgraphOptions<G, EK, NK>` / `SubgraphResult<G, NK, EK>` — fully generic option and result types
