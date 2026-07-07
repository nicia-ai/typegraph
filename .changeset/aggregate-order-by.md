---
"@nicia-ai/typegraph": minor
---

Aggregate queries now support `.orderBy()`. Previously `ExecutableAggregateQuery`
exposed `limit()` but no way to order results, so `.aggregate({...}).limit(n)`
returned an arbitrary `n` groups rather than the top `n` — the most common
aggregate shape ("top N groups by count/sum") required fetching every group
and sorting in JS.

`.orderBy(key, direction?)` takes any output name from `.aggregate({...})` —
either a grouped field or an aggregate alias — and can be chained for
multi-key sorts:

```typescript
store
  .query()
  .from("Author", "a")
  .traverse("wrote", "e")
  .to("Book", "b")
  .groupByNode("a")
  .aggregate({ author: field("a", "name"), bookCount: count("b") })
  .orderBy("bookCount", "desc")
  .limit(2)
  .execute();
```

Ordering resolves against the projected SELECT-list output alias rather than
recompiling the underlying expression, so it works uniformly for grouped
fields and aggregates on both SQLite and PostgreSQL with no dialect-specific
handling.
