---
"@nicia-ai/typegraph": minor
---

feat: support orderBy on edge properties in query builder

The `orderBy` method now accepts edge aliases in addition to node aliases, allowing results to be ordered by properties on traversed edges. This eliminates the need to denormalize ordering fields onto nodes or sort in memory.

```typescript
store.query()
  .from("Person", "p")
  .traverse("worksAt", "e")
  .to("Company", "c")
  .orderBy("e", "salary", "asc")  // order by edge property
  .select((ctx) => ({ name: ctx.p.name, salary: ctx.e.salary }))
  .execute();
```

Also fixes CTE alias resolution for edge aliases in `groupBy` and vector order-by compilation paths.

Closes #76
