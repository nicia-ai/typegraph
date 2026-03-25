---
"@nicia-ai/typegraph": minor
---

Add field-level projection to `store.subgraph()` via a declarative `project` option.

- **Declarative field selection**: Specify which properties to keep per node/edge kind. Projected nodes always retain `kind` and `id`; projected edges always retain structural endpoint fields. Kinds omitted from `project` remain fully hydrated.
- **SQL-level extraction**: Projected property fields are extracted via `json_extract()` / JSONB path expressions directly in the query, avoiding full `props` blob transfer for projected kinds.
- **All-or-nothing metadata**: Include `"meta"` in the field list for the full metadata object, or omit it entirely. No partial metadata selection — the struct is small enough that subsetting adds complexity without meaningful savings.
- **`defineSubgraphProject()` helper**: Curried identity function that preserves literal types for reusable projection configs. Without it, storing a projection in a variable widens field arrays to `string[]`, defeating compile-time narrowing.
- **Type-safe results**: Result types narrow per-kind based on the projection — accessing omitted fields is a compile-time error. Works through both inline literals and `defineSubgraphProject()`.

```typescript
const result = await store.subgraph(rootId, {
  edges: ["has_task", "uses_skill"],
  maxDepth: 2,
  project: {
    nodes: {
      Task: ["title", "meta"],
      Skill: ["name"],
    },
    edges: {
      uses_skill: ["priority"],
    },
  },
});
// result.nodes — Task has { kind, id, title, meta }; Skill has { kind, id, name }
// result.edges — uses_skill has { id, kind, fromKind, fromId, toKind, toId, priority }
```

Closes #46 (alternative implementation — declarative arrays instead of callbacks).
