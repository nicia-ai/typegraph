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
.orderBy(fieldSelector, direction?)
.orderBy(alias, field, direction?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `fieldSelector` | `(ctx) => field` | Function that selects the field to sort by |
| `alias` | `string` | Node/edge alias (alternative syntax) |
| `field` | `string` | Field name (alternative syntax) |
| `direction` | `"asc" \| "desc"` | Sort direction (default: `"asc"`) |

### Single Field

```typescript
// Function syntax
.orderBy((ctx) => ctx.p.name, "asc")

// Alias syntax
.orderBy("p", "name", "asc")
```

### Multiple Fields

Chain `orderBy()` for multi-field sorting:

```typescript
const sorted = await store
  .query()
  .from("Task", "t")
  .select((ctx) => ctx.t)
  .orderBy("t", "priority", "desc")    // Primary sort
  .orderBy("t", "createdAt", "asc")    // Secondary sort
  .execute();
```

Or use the array syntax:

```typescript
.orderBy((ctx) => [
  { field: ctx.t.priority, direction: "desc" },
  { field: ctx.t.createdAt, direction: "asc" },
])
```

### Null Handling

Control where null values appear:

```typescript
.orderBy((ctx) => ({
  field: ctx.p.email,
  direction: "asc",
  nulls: "last",  // or "first"
}))
```

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

Order by aggregate values:

```typescript
import { count, field } from "@nicia-ai/typegraph";

const topDepartments = await store
  .query()
  .from("Employee", "e")
  .groupBy("e", "department")
  .selectAggregate({
    department: field("e", "department"),
    headcount: count("e"),
  })
  .orderBy((ctx) => ctx.headcount, "desc")
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
  .orderBy("e", "createdAt", "desc")  // Required
  .stream();
```

### Stable Ordering

For deterministic pagination, include a unique field (like `id`) in your ordering:

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
  .orderBy("a", "createdAt", "desc")
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
