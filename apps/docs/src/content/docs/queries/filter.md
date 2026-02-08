---
title: Filter
description: Reducing results with whereNode() and whereEdge()
---

Filter operations reduce the result set based on property values. TypeGraph provides `whereNode()`
for filtering nodes and `whereEdge()` for filtering edges during traversals.

## whereNode()

Filter nodes based on their properties:

```typescript
const engineers = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.role.eq("Engineer"))
  .select((ctx) => ctx.p)
  .execute();
```

### Parameters

```typescript
.whereNode(alias, predicateFunction)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `alias` | `string` | The node alias to filter (must exist in query) |
| `predicateFunction` | `(accessor) => Predicate` | Function that returns a predicate |

The predicate function receives a typed accessor for the node's properties.

## whereEdge()

Filter based on edge properties during traversals:

```typescript
const highPaying = await store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e")
  .whereEdge("e", (e) => e.salary.gte(100000))
  .to("Company", "c")
  .select((ctx) => ({
    person: ctx.p.name,
    company: ctx.c.name,
    salary: ctx.e.salary,
  }))
  .execute();
```

### Parameters

```typescript
.whereEdge(alias, predicateFunction)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `alias` | `string` | The edge alias to filter (must exist in query) |
| `predicateFunction` | `(accessor) => Predicate` | Function that returns a predicate |

## Combining Predicates

### AND

Both conditions must be true:

```typescript
.whereNode("p", (p) =>
  p.status.eq("active").and(p.role.eq("admin"))
)
```

### OR

Either condition can be true:

```typescript
.whereNode("p", (p) =>
  p.role.eq("admin").or(p.role.eq("moderator"))
)
```

### NOT

Negate a condition:

```typescript
.whereNode("p", (p) =>
  p.status.eq("deleted").not()
)
```

### Complex Combinations

Build complex logic with parenthetical grouping:

```typescript
.whereNode("p", (p) =>
  p.status
    .eq("active")
    .and(p.role.eq("admin").or(p.role.eq("moderator")))
)
```

This evaluates as: `status = 'active' AND (role = 'admin' OR role = 'moderator')`

## Multiple Filters

Chain multiple `whereNode()` calls for AND logic:

```typescript
const activeManagers = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .whereNode("p", (p) => p.role.eq("Manager"))
  .select((ctx) => ctx.p)
  .execute();
```

This is equivalent to:

```typescript
.whereNode("p", (p) =>
  p.status.eq("active").and(p.role.eq("Manager"))
)
```

## Filtering After Traversal

Filter nodes at any point in the query:

```typescript
const techCompanyEngineers = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.role.eq("Engineer"))
  .traverse("worksAt", "e")
  .to("Company", "c")
  .whereNode("c", (c) => c.industry.eq("Technology"))
  .select((ctx) => ({
    person: ctx.p.name,
    company: ctx.c.name,
  }))
  .execute();
```

## Common Predicates

Here are the most commonly used predicates. For complete reference, see [Predicates](/queries/predicates/).

### Equality

```typescript
p.name.eq("Alice")       // equals
p.name.neq("Bob")        // not equals
```

### Comparison

```typescript
p.age.gt(21)             // greater than
p.age.gte(21)            // greater than or equal
p.age.lt(65)             // less than
p.age.lte(65)            // less than or equal
p.age.between(18, 65)    // inclusive range
```

### String Matching

```typescript
p.name.contains("ali")   // substring match
p.name.startsWith("A")   // prefix match
p.name.endsWith("ice")   // suffix match
p.email.like("%@example.com")  // SQL LIKE pattern
p.name.ilike("alice")    // case-insensitive LIKE
```

### Null Checks

```typescript
p.deletedAt.isNull()     // is null/undefined
p.email.isNotNull()      // is not null
```

### List Membership

```typescript
p.status.in(["active", "pending"])
p.status.notIn(["archived", "deleted"])
```

### Array Operations

```typescript
p.tags.contains("typescript")
p.tags.containsAll(["typescript", "nodejs"])
p.tags.containsAny(["typescript", "rust", "go"])
p.tags.isEmpty()
p.tags.isNotEmpty()
```

## Predicate Types by Field

The available predicates depend on the field type:

| Field Type | Key Predicates |
|------------|----------------|
| String | `eq`, `contains`, `startsWith`, `like`, `ilike` |
| Number | `eq`, `gt`, `gte`, `lt`, `lte`, `between` |
| Date | `eq`, `gt`, `gte`, `lt`, `lte`, `between` |
| Array | `contains`, `containsAll`, `containsAny`, `isEmpty` |
| Object | `get()`, `hasKey`, `pathEquals` |
| Embedding | `similarTo()` |

See [Predicates](/queries/predicates/) for complete documentation.

## Count and Existence Helpers

### Count Results

```typescript
const count: number = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .count();
```

### Check Existence

```typescript
const exists: boolean = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.email.eq("alice@example.com"))
  .exists();
```

### Get First Result

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

## Next Steps

- [Predicates](/queries/predicates/) - Complete predicate reference
- [Traverse](/queries/traverse) - Navigate relationships
- [Advanced](/queries/advanced) - Subqueries with `exists()` and `inSubquery()`
