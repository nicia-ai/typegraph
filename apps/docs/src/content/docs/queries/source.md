---
title: Source
description: Starting queries with from()
---

Every query starts with `from()`, which specifies the node kind to query and assigns an alias for
referencing it throughout the query.

## Basic Usage

```typescript
const results = await store
  .query()
  .from("Person", "p")  // Start from Person nodes, alias as "p"
  .select((ctx) => ctx.p)
  .execute();
```

## Parameters

```typescript
.from(kind, alias, options?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `kind` | `string` | The node kind to query (must exist in your graph definition) |
| `alias` | `string` | A unique identifier for referencing this node in the query |
| `options.includeSubClasses` | `boolean` | Include nodes of subclass kinds (default: `false`) |

## Aliases

The alias is used throughout the query to reference the node:

```typescript
const results = await store
  .query()
  .from("Person", "person")
  .whereNode("person", (p) => p.status.eq("active"))  // Reference in filter
  .orderBy("person", "name", "asc")                    // Reference in ordering
  .select((ctx) => ({
    name: ctx.person.name,                             // Reference in selection
    email: ctx.person.email,
  }))
  .execute();
```

Aliases must be unique within a query. TypeScript enforces this at compile time:

```typescript
store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e")
  .to("Company", "p")  // TypeScript error: alias "p" already in use
```

## Subclass Expansion

If your ontology defines subclass relationships, you can query a parent kind and include all subclasses:

```typescript
// Graph definition with subclass relationships:
// subClassOf(Podcast, Media)
// subClassOf(Article, Media)
// subClassOf(Video, Media)

// Query only exact Media nodes (default behavior)
const exactMedia = await store
  .query()
  .from("Media", "m")
  .select((ctx) => ctx.m)
  .execute();

// Query Media and all subclasses
const allMedia = await store
  .query()
  .from("Media", "m", { includeSubClasses: true })
  .select((ctx) => ({
    kind: ctx.m.kind,   // "Media" | "Podcast" | "Article" | "Video"
    title: ctx.m.title,
  }))
  .execute();
```

When `includeSubClasses: true`:

- Results include nodes of the specified kind AND all subclass kinds
- The `kind` field in results reflects the actual node kind
- All properties common to the parent kind are accessible

## Return Type

`from()` returns a `QueryBuilder` that provides access to all query methods:

- [Filter](/queries/filter) - `whereNode()`, `whereEdge()`
- [Traverse](/queries/traverse) - `traverse()`, `optionalTraverse()`
- [Shape](/queries/shape) - `select()`, `selectAggregate()`
- [Order](/queries/order) - `orderBy()`, `limit()`, `offset()`
- [Aggregate](/queries/aggregate) - `groupBy()`, `groupByNode()`
- [Temporal](/queries/temporal) - `temporal()`
- [Compose](/queries/compose) - `pipe()`

## Next Steps

- [Filter](/queries/filter) - Reduce results with `whereNode()`
- [Traverse](/queries/traverse) - Navigate to related nodes
- [Shape](/queries/shape) - Define output with `select()`
