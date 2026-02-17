---
title: Query Builder Overview
description: A fluent, type-safe API for querying your graph
---

TypeGraph provides a fluent, type-safe query builder for traversing and filtering your graph. This
page introduces the query categories and how they compose together.

## Query Categories

Every query builder method falls into one of these categories:

| Category | Purpose | Key Methods |
|----------|---------|-------------|
| [Source](/queries/source) | Entry point - where to start | `from()` |
| [Filter](/queries/filter) | Reduce the result set | `whereNode()`, `whereEdge()` |
| [Traverse](/queries/traverse) | Navigate relationships | `traverse()`, `optionalTraverse()`, `to()` |
| [Recursive](/queries/recursive) | Variable-length paths | `recursive()` |
| [Shape](/queries/shape) | Transform output structure | `select()`, `aggregate()` |
| [Aggregate](/queries/aggregate) | Summarize data | `groupBy()`, `count()`, `sum()`, `avg()` |
| [Order](/queries/order) | Control result ordering/size | `orderBy()`, `limit()`, `offset()` |
| [Temporal](/queries/temporal) | Time-based queries | `temporal()` |
| [Compose](/queries/compose) | Reusable query parts | `pipe()`, `createFragment()` |
| [Combine](/queries/combine) | Set operations | `union()`, `intersect()`, `except()` |
| [Execute](/queries/execute) | Run and retrieve | `execute()`, `first()`, `count()`, `exists()`, `paginate()`, `stream()` |

## Query Flow

A typical query follows this flow:

```text
Source → Filter → Traverse → Filter → Shape → Order → Execute
         ↑__________________|
           (repeat as needed)
```

Each step is optional except Source and Execute. You can filter, traverse, and filter again as many
times as needed before shaping and executing.

## Basic Example

```typescript
const results = await store
  .query()
  .from("Person", "p")                              // Source
  .whereNode("p", (p) => p.status.eq("active"))     // Filter
  .traverse("worksAt", "e")                         // Traverse
  .to("Company", "c")                               // Traverse (target)
  .whereNode("c", (c) => c.industry.eq("Tech"))     // Filter
  .select((ctx) => ({                               // Shape
    person: ctx.p.name,
    company: ctx.c.name,
    role: ctx.e.role,
  }))
  .orderBy("p", "name", "asc")                      // Order
  .limit(50)                                        // Order
  .execute();                                       // Execute
```

## Type Safety

The query builder is fully typed. TypeScript infers result types based on your schema and selection:

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

// Invalid property access is caught at compile time:
.select((ctx) => ({
  invalid: ctx.p.nonexistent,  // TypeScript error!
}))
```

## When to Use Queries vs Store API

**Use the query builder** when you need:

- Filtering based on node properties
- Traversing relationships between nodes
- Aggregating data across multiple nodes
- Complex predicates with AND/OR logic

**Use the [Store API](/schemas-stores#store-api)** for simple operations:

- Get a node by ID
- Create a new node
- Update a node's properties
- Delete a node

## Predicates Reference

Predicates are the building blocks for filtering. Each data type has its own set of predicates:

| Type | Documentation |
|------|--------------|
| String | [String Predicates](/queries/predicates/#string) |
| Number | [Number Predicates](/queries/predicates/#number) |
| Date | [Date Predicates](/queries/predicates/#date) |
| Array | [Array Predicates](/queries/predicates/#array) |
| Object | [Object Predicates](/queries/predicates/#object) |
| Embedding | [Embedding Predicates](/queries/predicates/#embedding) |

## Performance Tips

### Filter Early

Apply predicates as early as possible to reduce the working set:

```typescript
// Good: Filter at source
store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.active.eq(true))
  .traverse("worksAt", "e")
  .to("Company", "c");

// Less efficient: Filter after traversal
store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e")
  .to("Company", "c")
  .whereNode("p", (p) => p.active.eq(true));
```

### Be Specific with Kinds

Unless you need subclass expansion, use exact kinds:

```typescript
// More efficient: Exact kind
.from("Podcast", "p")

// Less efficient: Includes all subclasses
.from("Media", "m", { includeSubClasses: true })
```

### Always Paginate Large Results

```typescript
const page = await store
  .query()
  .from("Event", "e")
  .orderBy("e", "date", "desc")
  .limit(100)
  .execute();
```

## Next Steps

Start with the fundamentals:

1. [Source](/queries/source) - Starting queries with `from()`
2. [Filter](/queries/filter) - Reducing results with predicates
3. [Traverse](/queries/traverse) - Navigating relationships
4. [Shape](/queries/shape) - Transforming output with `select()`
