---
"@nicia-ai/typegraph": minor
---

Add `store.batch()` for executing multiple queries over a single connection with snapshot consistency.

- **Single connection**: Acquires one connection via an implicit transaction, eliminating pool pressure from parallel `Promise.all` patterns (N connections → 1).
- **Snapshot consistency**: All queries see the same database state — no interleaved writes between results.
- **Typed tuple results**: Returns a mapped tuple preserving each query's independent result type, projection, filtering, sorting, and pagination.
- **`BatchableQuery` interface**: Satisfied by both `ExecutableQuery` (from `.select()`) and `UnionableQuery` (from set operations like `.union()`, `.intersect()`). Exposes `executeOn()` for backend-delegated execution.
- **Minimum 2 queries**: Enforced at the type level — single queries should use `.execute()` directly.

```typescript
const [people, companies] = await store.batch(
  store.query()
    .from("Person", "p")
    .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name })),
  store.query()
    .from("Company", "c")
    .select((ctx) => ({ id: ctx.c.id, name: ctx.c.name }))
    .orderBy("c", "name", "asc")
    .limit(5),
);
// people:    readonly { id: string; name: string }[]
// companies: readonly { id: string; name: string }[]
```

Closes #47.
