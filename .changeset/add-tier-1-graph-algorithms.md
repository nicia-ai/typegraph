---
"@nicia-ai/typegraph": minor
---

Add Tier 1 graph algorithms on `store.algorithms.*`: `shortestPath`, `reachable`, `canReach`, `neighbors`, and `degree`.

```typescript
// Find the shortest path through a set of edge kinds
const path = await store.algorithms.shortestPath(alice, bob, {
  edges: ["knows"],
  maxHops: 6,
});

// Enumerate reachable nodes within a depth bound
const reachable = await store.algorithms.reachable(alice, {
  edges: ["knows"],
  maxHops: 3,
});

// Fast existence check
const connected = await store.algorithms.canReach(alice, bob, {
  edges: ["knows"],
});

// k-hop neighborhood (source always excluded)
const twoHop = await store.algorithms.neighbors(alice, {
  edges: ["knows"],
  depth: 2,
});

// Count incident edges
const total = await store.algorithms.degree(alice, { edges: ["knows"] });
```

All traversal algorithms compile to a single recursive-CTE query and share the dialect primitives used by `.recursive()` and `store.subgraph()`, so SQLite and PostgreSQL yield identical semantics. Node arguments accept either a raw ID string or any object with an `id` field — `Node`, `NodeRef`, and the lightweight records returned by the algorithms themselves all work. See `/graph-algorithms` for the full reference.
