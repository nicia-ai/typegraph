---
title: Predicates
description: Complete reference for filtering predicates by data type
---

Predicates are the building blocks for filtering in TypeGraph queries. Each data type has its own
set of predicates optimized for that type.

## How Predicates Work

Predicates are accessed through property accessors in `whereNode()` and `whereEdge()`:

```typescript
.whereNode("p", (p) => p.name.eq("Alice"))
//                     ^accessor ^predicate
```

The accessor provides type-safe access to the field, and returns a predicate builder with methods
appropriate for that field's type.

## Predicate Types

| Type | Common Predicates | Documentation |
|------|-------------------|---------------|
| String | `eq`, `contains`, `startsWith`, `like`, `ilike` | [String Predicates](#string) |
| Number | `eq`, `gt`, `gte`, `lt`, `lte`, `between` | [Number Predicates](#number) |
| Date | `eq`, `gt`, `gte`, `lt`, `lte`, `between` | [Date Predicates](#date) |
| Array | `contains`, `containsAll`, `containsAny`, `isEmpty` | [Array Predicates](#array) |
| Object | `get()`, `hasKey`, `pathEquals` | [Object Predicates](#object) |
| Embedding | `similarTo()` | [Embedding Predicates](#embedding) |

## Combining Predicates

All predicates can be combined using logical operators:

### AND

```typescript
p.status.eq("active").and(p.role.eq("admin"))
```

### OR

```typescript
p.role.eq("admin").or(p.role.eq("moderator"))
```

### NOT

```typescript
p.status.eq("deleted").not()
```

### Complex Combinations

```typescript
p.status
  .eq("active")
  .and(p.role.eq("admin").or(p.role.eq("moderator")))
```

## Common Predicates (All Types)

These predicates work on all field types:

| Predicate | Description |
|-----------|-------------|
| `eq(value)` | Equals |
| `neq(value)` | Not equals |
| `in(values[])` | Value is in array |
| `notIn(values[])` | Value is not in array |
| `isNull()` | Is null/undefined |
| `isNotNull()` | Is not null |

---

## String

String predicates for text matching and pattern searches.

### Equality

```typescript
p.name.eq("Alice")       // Exact match
p.name.neq("Bob")        // Not equal
```

### Contains

```typescript
p.name.contains("ali")   // Substring match (case-sensitive)
```

### Prefix/Suffix

```typescript
p.name.startsWith("A")   // Starts with
p.name.endsWith("ice")   // Ends with
```

### Pattern Matching

```typescript
p.email.like("%@example.com")  // SQL LIKE (% = any chars, _ = single char)
p.name.ilike("alice")          // Case-insensitive LIKE
```

### List Membership

```typescript
p.status.in(["active", "pending"])
p.status.notIn(["archived", "deleted"])
```

### Null Checks

```typescript
p.email.isNull()
p.email.isNotNull()
```

### Full Reference

| Predicate | Description | Example |
|-----------|-------------|---------|
| `eq(value)` | Exact match | `name.eq("Alice")` |
| `neq(value)` | Not equal | `name.neq("Bob")` |
| `contains(str)` | Contains substring | `name.contains("ali")` |
| `startsWith(str)` | Starts with prefix | `name.startsWith("A")` |
| `endsWith(str)` | Ends with suffix | `name.endsWith("ice")` |
| `like(pattern)` | SQL LIKE pattern | `email.like("%@example.com")` |
| `ilike(pattern)` | Case-insensitive LIKE | `name.ilike("alice")` |
| `in(values[])` | In array | `status.in(["a", "b"])` |
| `notIn(values[])` | Not in array | `status.notIn(["x"])` |
| `isNull()` | Is null | `email.isNull()` |
| `isNotNull()` | Is not null | `email.isNotNull()` |

---

## Number

Number predicates for numeric comparisons and ranges.

### Equality

```typescript
p.age.eq(30)
p.age.neq(0)
```

### Comparisons

```typescript
p.salary.gt(50000)   // Greater than
p.salary.gte(50000)  // Greater than or equal
p.age.lt(65)         // Less than
p.age.lte(65)        // Less than or equal
```

### Range

```typescript
p.age.between(18, 65)  // Inclusive range
```

### List Membership

```typescript
p.priority.in([1, 2, 3])
p.priority.notIn([0])
```

### Null Checks

```typescript
p.score.isNull()
p.score.isNotNull()
```

### Full Reference

| Predicate | Description | Example |
|-----------|-------------|---------|
| `eq(value)` | Equals | `age.eq(30)` |
| `neq(value)` | Not equals | `age.neq(0)` |
| `gt(value)` | Greater than | `salary.gt(50000)` |
| `gte(value)` | Greater than or equal | `salary.gte(50000)` |
| `lt(value)` | Less than | `age.lt(65)` |
| `lte(value)` | Less than or equal | `age.lte(65)` |
| `between(lo, hi)` | Inclusive range | `age.between(18, 65)` |
| `in(values[])` | In array | `priority.in([1, 2])` |
| `notIn(values[])` | Not in array | `priority.notIn([0])` |
| `isNull()` | Is null | `score.isNull()` |
| `isNotNull()` | Is not null | `score.isNotNull()` |

---

## Date

Date predicates for temporal comparisons. Accepts `Date` objects or ISO 8601 strings.

### Equality

```typescript
p.createdAt.eq("2024-01-01")
p.createdAt.neq(new Date("2024-01-01"))
```

### Comparisons

```typescript
p.createdAt.gt("2024-01-01")         // After
p.createdAt.gte("2024-01-01")        // On or after
p.createdAt.lt(new Date())           // Before now
p.createdAt.lte("2024-12-31")        // On or before
```

### Range

```typescript
p.createdAt.between("2024-01-01", "2024-12-31")
```

### List Membership

```typescript
p.birthday.in(["2024-01-01", "2024-07-04"])
```

### Null Checks

```typescript
p.deletedAt.isNull()
p.verifiedAt.isNotNull()
```

### Full Reference

| Predicate | Description | Example |
|-----------|-------------|---------|
| `eq(value)` | Equals | `createdAt.eq("2024-01-01")` |
| `neq(value)` | Not equals | `createdAt.neq("2024-01-01")` |
| `gt(value)` | After | `createdAt.gt("2024-01-01")` |
| `gte(value)` | On or after | `createdAt.gte("2024-01-01")` |
| `lt(value)` | Before | `createdAt.lt(new Date())` |
| `lte(value)` | On or before | `createdAt.lte("2024-12-31")` |
| `between(lo, hi)` | Inclusive range | `createdAt.between("2024-01-01", "2024-12-31")` |
| `in(values[])` | In array | `date.in(["2024-01-01"])` |
| `notIn(values[])` | Not in array | `date.notIn(["2024-01-01"])` |
| `isNull()` | Is null | `deletedAt.isNull()` |
| `isNotNull()` | Is not null | `verifiedAt.isNotNull()` |

---

## Array

Array predicates for fields that contain arrays (e.g., `tags: z.array(z.string())`).

### Contains

```typescript
p.tags.contains("typescript")              // Has specific value
p.tags.containsAll(["typescript", "nodejs"]) // Has ALL values
p.tags.containsAny(["typescript", "rust"])   // Has ANY value
```

### Empty Checks

```typescript
p.tags.isEmpty()      // Empty array OR null
p.tags.isNotEmpty()   // Has at least one element
```

### Length Predicates

```typescript
p.scores.lengthEq(3)    // Exactly 3 elements
p.scores.lengthGt(0)    // More than 0 elements
p.scores.lengthGte(3)   // 3 or more elements
p.scores.lengthLt(10)   // Fewer than 10 elements
p.scores.lengthLte(5)   // 5 or fewer elements
```

### Length Accessor

Access the array length as a number for complex predicates:

```typescript
p.tags.length.between(1, 5)  // 1-5 tags
```

### Full Reference

| Predicate | Description | Example |
|-----------|-------------|---------|
| `contains(value)` | Has value | `tags.contains("ts")` |
| `containsAll(values[])` | Has all values | `tags.containsAll(["a", "b"])` |
| `containsAny(values[])` | Has any value | `tags.containsAny(["a", "b"])` |
| `isEmpty()` | Empty or null | `tags.isEmpty()` |
| `isNotEmpty()` | Has elements | `tags.isNotEmpty()` |
| `lengthEq(n)` | Exactly n elements | `tags.lengthEq(3)` |
| `lengthGt(n)` | More than n | `tags.lengthGt(0)` |
| `lengthGte(n)` | n or more | `tags.lengthGte(3)` |
| `lengthLt(n)` | Fewer than n | `tags.lengthLt(10)` |
| `lengthLte(n)` | n or fewer | `tags.lengthLte(5)` |
| `length` | Length accessor | `tags.length.between(1, 5)` |

> **Note:** `isEmpty()` matches both empty arrays (`[]`) and null/undefined values. Use `isNull()`
> to check specifically for null.

---

## Object

Object predicates for JSON/object fields. Use JSON Pointer syntax for nested access.

### Nested Access

```typescript
p.metadata.get("theme").eq("dark")           // Access nested field
p.settings.get("notifications").get("email").eq(true)  // Deep nesting
```

### Key Existence

```typescript
p.metadata.hasKey("theme")                   // Has top-level key
```

### Path Operations

```typescript
p.config.hasPath("/nested/key")              // Has nested path
p.config.pathEquals("/settings/theme", "dark")  // Path equals value
p.config.pathContains("/tags", "featured")   // Path array contains
p.config.pathIsNull("/optional")             // Path is null
p.config.pathIsNotNull("/required")          // Path is not null
```

### Full Reference

| Predicate | Description | Example |
|-----------|-------------|---------|
| `get(key)` | Access nested field | `meta.get("theme").eq("dark")` |
| `hasKey(key)` | Has top-level key | `meta.hasKey("theme")` |
| `hasPath(pointer)` | Has nested path | `config.hasPath("/a/b")` |
| `pathEquals(pointer, value)` | Path equals value | `config.pathEquals("/theme", "dark")` |
| `pathContains(pointer, value)` | Path array contains | `config.pathContains("/tags", "x")` |
| `pathIsNull(pointer)` | Path is null | `config.pathIsNull("/opt")` |
| `pathIsNotNull(pointer)` | Path is not null | `config.pathIsNotNull("/req")` |

---

## Embedding

Embedding predicates for vector similarity search on embedding fields.

### similarTo()

Find similar vectors using distance metrics:

```typescript
p.embedding.similarTo(queryEmbedding, 10)  // Top 10 similar
```

### With Options

```typescript
p.embedding.similarTo(queryEmbedding, 10, {
  metric: "cosine",      // "cosine" | "l2" | "inner_product"
  minScore: 0.8,         // Minimum similarity threshold
})
```

### Full Reference

| Predicate | Description | Example |
|-----------|-------------|---------|
| `similarTo(embedding, k)` | Top k similar | `emb.similarTo(vec, 10)` |
| `similarTo(embedding, k, opts)` | With options | `emb.similarTo(vec, 10, { metric: "cosine" })` |

### Distance Metrics

| Metric | Description | Best For |
|--------|-------------|----------|
| `cosine` | Cosine similarity (default) | Normalized embeddings, semantic similarity |
| `l2` | Euclidean (L2) distance | Absolute distances, unnormalized vectors |
| `inner_product` | Inner product (PostgreSQL only) | Maximum inner product search (MIPS) |

### Example: Semantic Search

```typescript
const similar = await store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.embedding.similarTo(queryEmbedding, 20, {
      metric: "cosine",
      minScore: 0.7,
    })
  )
  .select((ctx) => ({
    id: ctx.d.id,
    title: ctx.d.title,
    content: ctx.d.content,
  }))
  .execute();
```

---

## Next Steps

- [Filter](/queries/filter) - Using predicates in queries
- [Overview](/queries/overview) - Query builder categories
