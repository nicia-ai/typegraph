---
"@nicia-ai/typegraph": minor
---

Graph algorithms (`store.algorithms.*`) and `store.subgraph()` now honor the store's temporal model.

**New:** Every algorithm and `store.subgraph()` accept `temporalMode` and `asOf` options, matching the shape already used by `store.query()` and collection reads. When neither is supplied, the resolved mode falls back to `graph.defaults.temporalMode` (typically `"current"`).

```typescript
// Snapshot at a point in time
await store.algorithms.shortestPath(alice, bob, {
  edges: ["knows"],
  temporalMode: "asOf",
  asOf: "2023-01-15T00:00:00Z",
});

await store.subgraph(rootId, {
  edges: ["has_task"],
  temporalMode: "includeEnded",
});
```

The filter applies to both nodes and edges along the traversal, is orthogonal to `cyclePolicy`, and is honored by the shortest-path self-path short-circuit.

**BREAKING:** `store.subgraph()` previously ignored graph temporal settings and filtered only by `deleted_at IS NULL` (equivalent to `"includeEnded"`). It now defaults to `graph.defaults.temporalMode`. Callers that relied on walking through validity-ended rows must pass `temporalMode: "includeEnded"` explicitly. Soft-delete filtering is unchanged under the default `"current"` mode, so most callers see no difference.
