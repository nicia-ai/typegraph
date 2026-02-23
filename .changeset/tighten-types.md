---
"@nicia-ai/typegraph": minor
---

Tighten type safety across store and collection APIs.

**Breaking:** `TypedNodeRef<N>` has been renamed to `NodeRef<N>` and the old untyped `NodeRef` has been removed. Replace `TypedNodeRef<N>` with `NodeRef<N>` — the type is structurally identical. Unparameterized `NodeRef` (with the new default) covers the old untyped usage.

- **`EdgeId<E>`** — branded edge ID type, mirroring `NodeId<N>`. Prevents mixing IDs from different edge types at compile time.
- **`Edge<E, From, To>`** — edge instances now carry endpoint node types. `edge.fromId` is `NodeId<From>`, `edge.toId` is `NodeId<To>`, and `edge.id` is `EdgeId<E>`.
- **`getNodeKinds` / `getEdgeKinds`** — return `readonly (keyof G["nodes"] & string)[]` instead of `readonly string[]`.
- **`constraintName` literal unions** — `findByConstraint`, `getOrCreateByConstraint`, and their bulk variants now only accept constraint names that exist on the node registration, catching typos at compile time.
