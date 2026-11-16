---
title: Order
description: Control result ordering with orderBy(), limit(), and offset()
---

Order operations control how results are sorted and how many are returned. Use `orderBy()` for
sorting, `limit()` to cap results, and `offset()` for simple pagination.

## orderBy()

Sort results by one or more fields:

```typescript
const sorted = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ctx.p)
  .orderBy((ctx) => ctx.p.name, "asc")
  .execute();
```

### Parameters

```typescript
.orderBy(expression, direction?)
.orderBy(alias, field, direction?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `expression` | `(ctx) => expression` | Builds the value to sort by from the query's aliases |
| `alias` | `string` | Node or edge alias (alias form) |
| `field` | typed field name | A declared property or a system field of `alias` (alias form) |
| `direction` | `"asc" \| "desc"` | Sort direction (default: `"asc"`) |

The alias form is the one [cursor pagination](/queries/execute#cursor-pagination)
and streaming accept; they refuse expression ordering.

### Single Field

```typescript
// Expression form
.orderBy((ctx) => ctx.p.name, "asc")

// Alias form
.orderBy("p", "name", "asc")
```

### Multiple Fields

Chain `orderBy()` for multi-field sorting:

```typescript
const sorted = await store
  .query()
  .from("Task", "t")
  .select((ctx) => ctx.t)
  .orderBy("t", "priority", "desc")        // Primary sort
  .orderBy("t", "meta.createdAt", "asc")   // Secondary sort
  .execute();
```

### Field Names

In the alias form, `field` is typed from the alias's kind. It accepts:

- a property the kind declares, by name (`"name"`, `"priority"`);
- `"id"` and `"kind"`;
- a metadata field by its path in a selected row: `"meta.validFrom"`,
  `"meta.validTo"`, `"meta.createdAt"`, `"meta.updatedAt"`,
  `"meta.deletedAt"`, and on a node alias `"meta.version"`;
- on an edge alias, `"fromId"` and `"toId"`.

The name is the path the value has in a selected row, so
`orderBy("t", "meta.createdAt")` sorts by the same value a full select returns
as `row.meta.createdAt`:

```typescript
const oldestFirst = await store
  .query()
  .from("Task", "t")
  .orderBy("t", "meta.validFrom", "asc")
  .select((ctx) => ctx.t)
  .execute();
```

Because metadata lives under `meta.`, it never collides with a property: a
kind that declares its own `createdAt` property is ordered by it with
`orderBy("t", "createdAt")`, and by TypeGraph's creation timestamp with
`orderBy("t", "meta.createdAt")`.

On a kind with a closed schema (`z.object`, `z.strictObject`, and objects
wrapped by `.refine()` or built with `.extend()`), any other name is a compile
error, and a `ConfigurationError` at runtime for callers the type checker does
not reach. A kind whose schema admits unknown keys (`z.looseObject`,
`.passthrough()`, `.catchall()`) may store keys it does not declare, so it orders
by any name as a property. A key stored outside a closed schema, for example by
an import with `onUnknownProperty: "allow"`, cannot be ordered by until the
schema declares it (`z.string().optional()` is enough). The names are the same
whether `orderBy()` appears before or after `select()`.

### Null Handling

Nulls sort last in ascending order and first in descending order, on both
backends. Nullable system fields (`meta.validFrom`, `meta.validTo`,
`meta.deletedAt`) and optional properties follow the same rule.

### Ordering by Edge Properties

Order by properties on traversed edges:

```typescript
const employees = await store
  .query()
  .from("Company", "c")
  .traverse("worksAt", "e", { direction: "in" })
  .to("Person", "p")
  .select((ctx) => ({
    name: ctx.p.name,
    startDate: ctx.e.startDate,
  }))
  .orderBy("e", "startDate", "desc")  // Most recent hires first
  .execute();
```

### Ordering Aggregated Results

Aggregate queries have their own `orderBy(key, direction?)`, called after
`.aggregate({...})`. `key` is any output name from the fields object — a
grouped field or an aggregate alias:

```typescript
import { count, field } from "@nicia-ai/typegraph";

const topDepartments = await store
  .query()
  .from("Employee", "e")
  .groupBy("e", "department")
  .aggregate({
    department: field("e", "department"),
    headcount: count("e"),
  })
  .orderBy("headcount", "desc")
  .execute();
```

## limit()

Cap the number of results returned:

```typescript
const top10 = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ctx.p)
  .orderBy("p", "score", "desc")
  .limit(10)
  .execute();
```

### Parameters

```typescript
.limit(n)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `n` | `number` | Maximum number of results to return |

## offset()

Skip a number of results (useful for simple pagination):

```typescript
const page2 = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ctx.p)
  .orderBy("p", "name", "asc")
  .limit(10)
  .offset(10)  // Skip first 10 results
  .execute();
```

### Parameters

```typescript
.offset(n)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `n` | `number` | Number of results to skip |

## Simple Pagination with limit/offset

```typescript
async function getPage(pageNumber: number, pageSize: number) {
  return store
    .query()
    .from("Person", "p")
    .select((ctx) => ctx.p)
    .orderBy("p", "name", "asc")
    .limit(pageSize)
    .offset((pageNumber - 1) * pageSize)
    .execute();
}

// Usage
const page1 = await getPage(1, 20);  // Results 1-20
const page2 = await getPage(2, 20);  // Results 21-40
```

> **Note:** For large datasets, use [cursor pagination](/queries/execute#cursor-pagination) instead.
> Offset-based pagination becomes slower as offset increases.

## Ordering Requirements

### For Pagination

Both `paginate()` and `stream()` require an `orderBy()` clause:

```typescript
// Required for pagination
const page = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ctx.p)
  .orderBy("p", "name", "asc")    // Required
  .paginate({ first: 20 });

// Required for streaming
const stream = store
  .query()
  .from("Event", "e")
  .select((ctx) => ctx.e)
  .orderBy("e", "meta.createdAt", "desc")  // Required
  .stream();
```

### Stable Ordering

Cursor pagination and streaming automatically append missing start-node identity keys: `id ASC`
for a single kind, or `kind ASC` and `id ASC` for a multi-kind source. Existing caller-specified
identity ordering is preserved. Offset pagination needs an explicit total ordering.

For deterministic offset pagination of one kind, include `id` in your ordering:

```typescript
.orderBy("p", "name", "asc")
.orderBy("p", "id", "asc")    // Ensures stable ordering when names are equal
```

## Real-World Examples

### Leaderboard

```typescript
const leaderboard = await store
  .query()
  .from("Player", "p")
  .select((ctx) => ({
    name: ctx.p.name,
    score: ctx.p.score,
  }))
  .orderBy("p", "score", "desc")
  .limit(100)
  .execute();
```

### Recent Activity Feed

```typescript
const feed = await store
  .query()
  .from("Activity", "a")
  .whereNode("a", (a) => a.userId.eq(currentUserId))
  .select((ctx) => ctx.a)
  .orderBy("a", "meta.createdAt", "desc")
  .limit(50)
  .execute();
```

### Paginated Search Results

```typescript
async function searchProducts(query: string, page: number) {
  const pageSize = 20;

  return store
    .query()
    .from("Product", "p")
    .whereNode("p", (p) => p.name.ilike(`%${query}%`))
    .select((ctx) => ({
      id: ctx.p.id,
      name: ctx.p.name,
      price: ctx.p.price,
    }))
    .orderBy("p", "relevance", "desc")
    .orderBy("p", "id", "asc")
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
}
```

## Next Steps

- [Execute](/queries/execute) - Cursor pagination and streaming
- [Shape](/queries/shape) - Output transformation
- [Filter](/queries/filter) - Reducing results with predicates

## Newest target through an edge

When the source node is already available, `store.neighbors()` is the direct one-statement read:

```typescript
const [latest] = await store.neighbors(document, {
  edges: ["hasVersion"],
  orderBy: { by: "node", field: "sequence", direction: "desc" },
  limit: 1,
});
```

Use `by: "edge"` (or omit `by`) for edge metadata and `by: "node"` for an adjacent-node property.
Both forms sort nulls last and use the edge ID as the deterministic final tie-breaker.

The equivalent fluent traversal is useful when additional target predicates or projections are
needed:

```typescript
const [newest] = await store.query()
  .from("Document", "document")
  .whereNode("document", (node) => node.id.eq(documentId))
  .traverse("hasVersion", "edge").to("Version", "version")
  .orderBy("version", "sequence", "desc")
  .orderBy("version", "id", "desc")
  .select((ctx) => ctx.version)
  .limit(1)
  .execute();
```

The ID order resolves ties deterministically. With no matching target, `newest` is `undefined`.
