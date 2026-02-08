---
title: Shape
description: Transform output structure with select() and selectAggregate()
---

Shape operations transform how results are returned. Use `select()` to define the output structure
and `selectAggregate()` for grouped/aggregated results.

## select()

The `select()` method defines what data to return:

```typescript
const results = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ({
    name: ctx.p.name,
    email: ctx.p.email,
  }))
  .execute();
```

### Parameters

```typescript
.select(selectFunction)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `selectFunction` | `(ctx) => T` | Function that receives a context and returns the output shape |

The context provides typed access to all nodes and edges in the query via their aliases.

## Selection Patterns

### Full Node

Return all properties as an object:

```typescript
.select((ctx) => ctx.p)

// Returns: { id, kind, name, email, ... }
```

### Specific Fields

Return only the fields you need:

```typescript
.select((ctx) => ({
  id: ctx.p.id,
  name: ctx.p.name,
  email: ctx.p.email,
}))
```

:::tip[Performance]
Selecting specific fields triggers TypeGraph's **smart select optimization**. Instead of fetching
the entire `props` blob, TypeGraph generates SQL that extracts only the requested fields. This
can significantly improve performance, especially with well-designed [indexes](/performance/indexes).
:::

### Node Metadata

Include system metadata fields:

```typescript
.select((ctx) => ({
  id: ctx.p.id,
  kind: ctx.p.kind,           // "Person"
  version: ctx.p.version,     // Optimistic concurrency version
  createdAt: ctx.p.createdAt,
  updatedAt: ctx.p.updatedAt,
}))
```

### Multiple Nodes

Select from multiple nodes in a traversal:

```typescript
const results = await store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e")
  .to("Company", "c")
  .select((ctx) => ({
    person: ctx.p.name,
    company: ctx.c.name,
    role: ctx.e.role,         // Edge property
  }))
  .execute();
```

### Nested Objects

Structure output with nested objects:

```typescript
.select((ctx) => ({
  employee: {
    id: ctx.p.id,
    name: ctx.p.name,
  },
  company: {
    id: ctx.c.id,
    name: ctx.c.name,
  },
  employment: {
    role: ctx.e.role,
    startDate: ctx.e.startDate,
  },
}))
```

### Renamed Fields

Rename fields in the output:

```typescript
.select((ctx) => ({
  personName: ctx.p.name,      // Renamed from 'name'
  companyName: ctx.c.name,     // Renamed from 'name'
  jobTitle: ctx.e.role,        // Renamed from 'role'
}))
```

## Type Inference

TypeScript infers the result type from your selection:

```typescript
// TypeScript infers: Array<{ name: string; email: string | undefined }>
const results = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ({
    name: ctx.p.name,    // string (required in schema)
    email: ctx.p.email,  // string | undefined (optional in schema)
  }))
  .execute();

// Invalid property access caught at compile time:
.select((ctx) => ({
  invalid: ctx.p.nonexistent,  // TypeScript error!
}))
```

## Optional Traversal Results

When using `optionalTraverse()`, accessed nodes and edges may be `undefined`:

```typescript
const results = await store
  .query()
  .from("Person", "p")
  .optionalTraverse("worksAt", "e")
  .to("Company", "c")
  .select((ctx) => ({
    person: ctx.p.name,
    company: ctx.c?.name,      // May be undefined
    role: ctx.e?.role,         // May be undefined
  }))
  .execute();
```

## selectAggregate()

Use `selectAggregate()` with aggregate functions for grouped queries:

```typescript
import { count, sum, avg, field } from "@nicia-ai/typegraph";

const stats = await store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e")
  .to("Company", "c")
  .groupBy("c", "name")
  .selectAggregate({
    companyName: field("c", "name"),
    employeeCount: count("p"),
    totalSalary: sum("e", "salary"),
    avgSalary: avg("e", "salary"),
  })
  .execute();
```

See [Aggregate](/queries/aggregate) for full aggregate documentation.

## Selecting Path Information

With recursive traversals, include path and depth:

```typescript
const results = await store
  .query()
  .from("Category", "cat")
  .traverse("parentCategory", "e")
  .recursive()
  .collectPath("pathIds")
  .withDepth("depth")
  .to("Category", "ancestor")
  .select((ctx) => ({
    category: ctx.cat.name,
    ancestor: ctx.ancestor.name,
    path: ctx.pathIds,          // Array of node IDs
    depth: ctx.depth,           // Number of hops
  }))
  .execute();
```

## Temporal Metadata

When using [temporal queries](/queries/temporal), access validity information:

```typescript
const history = await store
  .query()
  .from("Article", "a")
  .temporal("includeEnded")
  .select((ctx) => ({
    title: ctx.a.title,
    validFrom: ctx.a.validFrom,   // When this version became valid
    validTo: ctx.a.validTo,       // When superseded (undefined if current)
    version: ctx.a.version,       // Version number
  }))
  .execute();
```

## Return Type

`select()` returns an `ExecutableQuery` that provides:

- `execute()` - Run the query and get results
- `paginate()` - Cursor-based pagination
- `stream()` - Stream results for large datasets
- `first()` - Get the first result or undefined
- `count()` - Count matching results
- `exists()` - Check if any results exist
- `toAst()` - Get the query AST
- `compile()` - Compile to SQL

## Next Steps

- [Aggregate](/queries/aggregate) - Grouping and aggregate functions
- [Order](/queries/order) - Ordering and limiting results
- [Execute](/queries/execute) - Running queries and pagination
