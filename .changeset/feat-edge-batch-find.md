---
"@nicia-ai/typegraph": minor
---

Add `batchFindFrom`, `batchFindTo`, and `batchFindByEndpoints` to edge collections for use with `store.batch()`.

Edge collection lookup methods (`findFrom`, `findTo`, `findByEndpoints`) execute immediately and cannot participate in `store.batch()`. The new `batchFind*` variants return a `BatchableQuery` instead, enabling edge lookups to share a single transactional connection alongside fluent queries.

```typescript
const [skills, employer, colleague] = await store.batch(
  store.edges.hasSkill.batchFindFrom(alice),
  store.edges.worksAt.batchFindFrom(alice),
  store.edges.knows.batchFindByEndpoints(alice, bob),
);
```

- **`batchFindFrom(from)`** — deferred variant of `findFrom`
- **`batchFindTo(to)`** — deferred variant of `findTo`
- **`batchFindByEndpoints(from, to, options?)`** — deferred variant of `findByEndpoints`, returns 0-or-1 element array

All three preserve the same endpoint type constraints as their immediate counterparts.

Closes #51.
