---
title: Execute
description: Running queries with execute(), paginate(), and stream()
---

Execute operations run your query and retrieve results. Use `execute()` for simple queries,
`paginate()` for cursor-based pagination, and `stream()` for processing large datasets.

## execute()

Run the query and return all results:

```typescript
const results = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .select((ctx) => ctx.p)
  .execute();

// results: readonly Person[]
```

### Return Type

Returns a readonly array of the selected type:

```typescript
// TypeScript infers the shape from your selection
const results = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ({
    name: ctx.p.name,
    email: ctx.p.email,
  }))
  .execute();

// results: readonly { name: string; email: string | undefined }[]
```

## first()

Get the first result or `undefined`:

```typescript
const alice = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.email.eq("alice@example.com"))
  .select((ctx) => ctx.p)
  .first();

if (alice) {
  console.log(alice.name);
}
```

## count()

Count matching results without fetching data:

```typescript
const activeCount = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .count();

// activeCount: number
```

## exists()

Check if any results exist:

```typescript
const hasActiveUsers = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .exists();

// hasActiveUsers: boolean
```

## Cursor Pagination

For large datasets, cursor-based pagination is more efficient than `limit`/`offset`. It uses keyset
pagination which doesn't degrade as you go deeper.

### paginate()

```typescript
const firstPage = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ({
    id: ctx.p.id,
    name: ctx.p.name,
  }))
  .orderBy("p", "name", "asc")    // ORDER BY required
  .paginate({ first: 20 });
```

### Pagination Result Shape

```typescript
{
  data: readonly T[],           // The actual results
  hasNextPage: boolean,         // More results available forward
  hasPrevPage: boolean,         // More results available backward
  nextCursor: string | undefined,  // Opaque cursor for next page
  prevCursor: string | undefined,  // Opaque cursor for previous page
}
```

### Forward Pagination

Use `first` and `after` to paginate forward:

```typescript
// Get first page
const page1 = await query.paginate({ first: 20 });

// Get next page using the cursor
if (page1.hasNextPage && page1.nextCursor) {
  const page2 = await query.paginate({
    first: 20,
    after: page1.nextCursor,
  });
}
```

### Backward Pagination

Use `last` and `before` to paginate backward:

```typescript
// Get last page
const lastPage = await query.paginate({ last: 20 });

// Get previous page
if (lastPage.hasPrevPage && lastPage.prevCursor) {
  const prevPage = await query.paginate({
    last: 20,
    before: lastPage.prevCursor,
  });
}
```

### Pagination Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `first` | `number` | Number of results from the start |
| `after` | `string` | Cursor to start after (forward pagination) |
| `last` | `number` | Number of results from the end |
| `before` | `string` | Cursor to start before (backward pagination) |

### Pagination with Traversals

Pagination works with graph traversals:

```typescript
const employeesPage = await store
  .query()
  .from("Company", "c")
  .whereNode("c", (c) => c.name.eq("Acme Corp"))
  .traverse("worksAt", "e", { direction: "in" })
  .to("Person", "p")
  .select((ctx) => ({
    id: ctx.p.id,
    name: ctx.p.name,
    role: ctx.e.role,
  }))
  .orderBy("p", "name", "asc")
  .paginate({ first: 50 });
```

## Streaming

For very large datasets, use streaming to process results without loading everything into memory.

### stream()

```typescript
const stream = store
  .query()
  .from("Event", "e")
  .select((ctx) => ctx.e)
  .orderBy("e", "createdAt", "desc")  // ORDER BY required
  .stream({ batchSize: 1000 });

// Process results as they arrive
for await (const event of stream) {
  console.log(event.title);
  await processEvent(event);
}
```

### Batch Size

The `batchSize` option controls how many records are fetched per database query:

```typescript
// Smaller batches: Lower memory usage, more database queries
.stream({ batchSize: 100 })

// Larger batches: Higher memory usage, fewer database queries
.stream({ batchSize: 5000 })

// Default is 1000
.stream()
```

### Streaming with Processing

```typescript
async function exportAllUsers(): Promise<void> {
  const stream = store
    .query()
    .from("User", "u")
    .whereNode("u", (u) => u.status.eq("active"))
    .select((ctx) => ({
      id: ctx.u.id,
      email: ctx.u.email,
      name: ctx.u.name,
    }))
    .orderBy("u", "id", "asc")
    .stream({ batchSize: 500 });

  let count = 0;
  for await (const user of stream) {
    await exportToExternalSystem(user);
    count++;
    if (count % 1000 === 0) {
      console.log(`Exported ${count} users...`);
    }
  }
  console.log(`Export complete: ${count} users`);
}
```

## Prepared Queries

Prepared queries let you compile a query once and execute it many times with different parameter
values. This eliminates recompilation overhead for repeated query shapes.

### `param(name)`

Use `param()` to declare a named placeholder inside any predicate position:

```typescript
import { param } from "@nicia-ai/typegraph";
```

### `prepare()`

Call `.prepare()` on an executable query to pre-compile the AST and SQL. Returns a `PreparedQuery<R>`
that can be executed with different bindings.

```typescript
const findByName = store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq(param("name")))
  .select((ctx) => ctx.p)
  .prepare();

// Execute with different bindings — no recompilation
const alices = await findByName.execute({ name: "Alice" });
const bobs = await findByName.execute({ name: "Bob" });
```

### Parameterized Bounds

Parameters work anywhere a scalar value is accepted:

```typescript
const findByAge = store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.age.between(param("minAge"), param("maxAge")))
  .select((ctx) => ctx.p)
  .prepare();

const youngAdults = await findByAge.execute({ minAge: 18, maxAge: 25 });
const seniors = await findByAge.execute({ minAge: 65, maxAge: 120 });
```

`prepared.execute(bindings)` validates bindings strictly: all declared parameters must be
provided, and unknown binding keys are rejected.

### Supported Positions

`param()` works with any scalar predicate:

| Predicate | Example |
|-----------|---------|
| `eq` / `neq` | `p.name.eq(param("name"))` |
| `gt` / `gte` / `lt` / `lte` | `p.age.gt(param("minAge"))` |
| `between` | `p.age.between(param("lo"), param("hi"))` |
| `contains` | `p.name.contains(param("substr"))` |
| `startsWith` / `endsWith` | `p.name.startsWith(param("prefix"))` |
| `like` / `ilike` | `p.email.like(param("pattern"))` |

:::caution
`param()` is **not** supported in `in()` / `notIn()` — the array length must be known at compile time.
:::

### Performance

When the backend supports `executeRaw` (both SQLite and PostgreSQL backends do), the pre-compiled
SQL text is sent directly to the database driver with substituted parameter values — zero
recompilation overhead. When `executeRaw` is unavailable, the prepared query substitutes parameters
into the AST and recompiles.

## Query Debugging

### toAst()

Get the query AST for inspection:

```typescript
const builder = store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .select((ctx) => ctx.p);

const ast = builder.toAst();
console.log(JSON.stringify(ast, null, 2));
```

### compile()

Compile to SQL without executing:

```typescript
const compiled = builder.compile();
console.log("SQL:", compiled.sql);
console.log("Parameters:", compiled.params);
```

Useful for:

- Debugging query behavior
- Understanding performance characteristics
- Building custom query executors

## Ordering Requirements

Both `paginate()` and `stream()` require an `orderBy()` clause:

```typescript
// Required for pagination
.orderBy("p", "name", "asc")
.paginate({ first: 20 });

// Required for streaming
.orderBy("e", "createdAt", "desc")
.stream();
```

### Stable Ordering

For deterministic pagination, include a unique field in your ordering:

```typescript
.orderBy("p", "name", "asc")
.orderBy("p", "id", "asc")    // Ensures stable ordering
```

## Real-World Examples

### Paginated API Endpoint

```typescript
async function listUsers(cursor?: string, limit = 20) {
  const query = store
    .query()
    .from("User", "u")
    .whereNode("u", (u) => u.status.eq("active"))
    .select((ctx) => ({
      id: ctx.u.id,
      name: ctx.u.name,
      email: ctx.u.email,
    }))
    .orderBy("u", "createdAt", "desc")
    .orderBy("u", "id", "desc");

  const result = cursor
    ? await query.paginate({ first: limit, after: cursor })
    : await query.paginate({ first: limit });

  return {
    users: result.data,
    nextCursor: result.nextCursor,
    hasMore: result.hasNextPage,
  };
}
```

### Batch Processing

```typescript
async function processAllOrders() {
  const stream = store
    .query()
    .from("Order", "o")
    .whereNode("o", (o) => o.status.eq("pending"))
    .select((ctx) => ctx.o)
    .orderBy("o", "createdAt", "asc")
    .stream({ batchSize: 100 });

  for await (const order of stream) {
    try {
      await fulfillOrder(order);
      await store.update("Order", order.id, { status: "fulfilled" });
    } catch (error) {
      console.error(`Failed to process order ${order.id}:`, error);
    }
  }
}
```

### Infinite Scroll

```typescript
function useInfiniteUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(true);

  async function loadMore() {
    const result = await store
      .query()
      .from("User", "u")
      .select((ctx) => ctx.u)
      .orderBy("u", "name", "asc")
      .paginate({ first: 20, after: cursor });

    setUsers((prev) => [...prev, ...result.data]);
    setCursor(result.nextCursor);
    setHasMore(result.hasNextPage);
  }

  return { users, loadMore, hasMore };
}
```

## Next Steps

- [Order](/queries/order) - Ordering and limiting results
- [Shape](/queries/shape) - Output transformation
- [Overview](/queries/overview) - Query categories reference
