---
"@nicia-ai/typegraph": minor
---

Support unconstrained edges in `defineGraph`.

Edges defined without `from`/`to` constraints (e.g., `defineEdge("sameAs")`) can now be passed directly to `defineGraph` without an `EdgeRegistration` wrapper. They are automatically allowed to connect any node type in the graph to any other.

- **`EdgeEntry` widened** — accepts any `EdgeType`, not just those with endpoints
- **`NormalizedEdges`** — falls back to all graph node types when `from`/`to` are undefined
- Constrained edges, `EdgeRegistration` wrappers, and narrowing validation are unchanged
