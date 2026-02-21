---
"@nicia-ai/typegraph": minor
---

Add read-only lookup methods and store-level clear for graph data management.

**New APIs:**

- `findByConstraint` / `bulkFindByConstraint` — look up nodes by a named uniqueness constraint without creating. Returns `Node<N> | undefined` (or `(Node<N> | undefined)[]` for bulk). Soft-deleted nodes are excluded.
- `findByEndpoints` — look up an edge by `(from, to)` with optional `matchOn` property fields without creating. Returns `Edge<E> | undefined`. Soft-deleted edges are excluded.
- `store.clear()` — hard-delete all data for the current graph (nodes, edges, uniques, embeddings, schema versions). Resets collection caches so the store is immediately reusable.
