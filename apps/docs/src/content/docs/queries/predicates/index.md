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
appropriate for that field's type. Edge fields work the same way:

```typescript
.whereEdge("e", (e) => e.role.eq("admin"))
```

## Predicate Types

| Type | Predicates | Section |
|------|------------|---------|
| All types | `eq`, `neq`, `in`, `notIn`, `isNull`, `isNotNull` | [Common](#common-predicates) |
| String | `contains`, `startsWith`, `endsWith`, `like`, `ilike` | [String](#string) |
| Number | `gt`, `gte`, `lt`, `lte`, `between` | [Number](#number) |
| Boolean | *(common only)* | [Boolean](#boolean) |
| Date | `gt`, `gte`, `lt`, `lte`, `between` | [Date](#date) |
| Array | `contains`, `containsAll`, `containsAny`, `isEmpty`, `isNotEmpty`, `lengthEq/Gt/Gte/Lt/Lte` | [Array](#array) |
| Object | `get`, `field`, `hasKey`, `hasPath`, `pathEquals`, `pathContains`, `pathIsNull`, `pathIsNotNull` | [Object](#object) |
| Embedding | `similarTo` | [Embedding](#embedding) |
| Subquery | `exists`, `notExists`, `inSubquery`, `notInSubquery` | [Subqueries](/queries/advanced) |

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

Parenthesization is handled automatically. Vector similarity predicates cannot be nested under
`OR` or `NOT`.

---

## Common Predicates

These predicates are available on **all** field types:

| Predicate | Description | SQL |
|-----------|-------------|-----|
| `eq(value)` | Equals | `= value` |
| `neq(value)` | Not equals | `!= value` |
| `in(values[])` | Value is in array | `IN (...)` |
| `notIn(values[])` | Value is not in array | `NOT IN (...)` |
| `isNull()` | Is null/undefined | `IS NULL` |
| `isNotNull()` | Is not null | `IS NOT NULL` |

`eq` and `neq` accept `param()` references for [prepared queries](/queries/execute#prepared-queries).
`in` and `notIn` do **not** support `param()` because the array length must be known at compile time.

---

## String

String predicates for text matching and pattern searches.

### Equality

```typescript
p.name.eq("Alice")       // Exact match
p.name.neq("Bob")        // Not equal
```

### Substring Match

```typescript
p.name.contains("ali")   // Case-insensitive substring match
```

### Prefix/Suffix

```typescript
p.name.startsWith("A")   // Case-insensitive prefix match
p.name.endsWith("ice")   // Case-insensitive suffix match
```

### Pattern Matching

```typescript
p.email.like("%@example.com")  // SQL LIKE (case-sensitive) — % = any chars, _ = single char
p.name.ilike("alice%")         // Case-insensitive LIKE
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

### Reference

| Predicate | Accepts | Description | SQL | Case |
|-----------|---------|-------------|-----|------|
| `eq(value)` | `string \| param()` | Exact match | `=` | sensitive |
| `neq(value)` | `string \| param()` | Not equal | `!=` | sensitive |
| `contains(str)` | `string \| param()` | Substring match | `ILIKE '%str%'` | insensitive |
| `startsWith(str)` | `string \| param()` | Prefix match | `ILIKE 'str%'` | insensitive |
| `endsWith(str)` | `string \| param()` | Suffix match | `ILIKE '%str'` | insensitive |
| `like(pattern)` | `string \| param()` | SQL LIKE pattern | `LIKE` | sensitive |
| `ilike(pattern)` | `string \| param()` | Case-insensitive LIKE | `ILIKE` | insensitive |
| `in(values[])` | `string[]` | In array | `IN (...)` | sensitive |
| `notIn(values[])` | `string[]` | Not in array | `NOT IN (...)` | sensitive |
| `isNull()` | — | Is null | `IS NULL` | — |
| `isNotNull()` | — | Is not null | `IS NOT NULL` | — |

> **Wildcard escaping:** User input passed to `contains`, `startsWith`, and `endsWith` is
> automatically escaped — `%` and `_` characters are treated as literals. Use `like` or `ilike`
> when you need wildcard control.

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
p.age.between(18, 65)  // Inclusive on both bounds
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

### Reference

| Predicate | Accepts | Description | SQL |
|-----------|---------|-------------|-----|
| `eq(value)` | `number \| param()` | Equals | `=` |
| `neq(value)` | `number \| param()` | Not equals | `!=` |
| `gt(value)` | `number \| param()` | Greater than | `>` |
| `gte(value)` | `number \| param()` | Greater than or equal | `>=` |
| `lt(value)` | `number \| param()` | Less than | `<` |
| `lte(value)` | `number \| param()` | Less than or equal | `<=` |
| `between(lo, hi)` | `number \| param()` | Inclusive range | `BETWEEN lo AND hi` |
| `in(values[])` | `number[]` | In array | `IN (...)` |
| `notIn(values[])` | `number[]` | Not in array | `NOT IN (...)` |
| `isNull()` | — | Is null | `IS NULL` |
| `isNotNull()` | — | Is not null | `IS NOT NULL` |

---

## Boolean

Boolean fields support only the [common predicates](#common-predicates):

```typescript
p.isActive.eq(true)
p.isActive.neq(false)
p.isVerified.isNull()
p.role.in(["admin", "moderator"])  // works on string enums too
```

No additional boolean-specific predicates are provided — `eq(true)` and `eq(false)` cover the
typical cases.

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

### Reference

| Predicate | Accepts | Description | SQL |
|-----------|---------|-------------|-----|
| `eq(value)` | `Date \| string \| param()` | Equals | `=` |
| `neq(value)` | `Date \| string \| param()` | Not equals | `!=` |
| `gt(value)` | `Date \| string \| param()` | After | `>` |
| `gte(value)` | `Date \| string \| param()` | On or after | `>=` |
| `lt(value)` | `Date \| string \| param()` | Before | `<` |
| `lte(value)` | `Date \| string \| param()` | On or before | `<=` |
| `between(lo, hi)` | `Date \| string \| param()` | Inclusive range | `BETWEEN lo AND hi` |
| `in(values[])` | `(Date \| string)[]` | In array | `IN (...)` |
| `notIn(values[])` | `(Date \| string)[]` | Not in array | `NOT IN (...)` |
| `isNull()` | — | Is null | `IS NULL` |
| `isNotNull()` | — | Is not null | `IS NOT NULL` |

---

## Array

Array predicates for fields that contain arrays (e.g., `tags: z.array(z.string())`).

### Containment

```typescript
p.tags.contains("typescript")              // Has specific value
p.tags.containsAll(["typescript", "nodejs"]) // Has ALL values
p.tags.containsAny(["typescript", "rust"])   // Has ANY value
```

Containment predicates (`contains`, `containsAll`, `containsAny`) are only available when the
array element type is a scalar — `string`, `number`, `boolean`, or `Date`. They will not
type-check for arrays of objects or arrays.

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

### Reference

| Predicate | Accepts | Description | SQL |
|-----------|---------|-------------|-----|
| `contains(value)` | `T` | Has value | JSON array contains |
| `containsAll(values[])` | `T[]` | Has all values | AND of contains |
| `containsAny(values[])` | `T[]` | Has any value | OR of contains |
| `isEmpty()` | — | Empty or null | `IS NULL OR length = 0` |
| `isNotEmpty()` | — | Has elements | `IS NOT NULL AND length > 0` |
| `lengthEq(n)` | `number` | Exactly n elements | `json_array_length(col) = n` |
| `lengthGt(n)` | `number` | More than n | `json_array_length(col) > n` |
| `lengthGte(n)` | `number` | n or more | `json_array_length(col) >= n` |
| `lengthLt(n)` | `number` | Fewer than n | `json_array_length(col) < n` |
| `lengthLte(n)` | `number` | n or fewer | `json_array_length(col) <= n` |

> **Note:** `isEmpty()` matches both empty arrays (`[]`) and null/undefined values. Use `isNull()`
> to check specifically for null.

---

## Object

Object predicates for JSON/object fields. Supports both fluent chaining with `get()` and
[JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) syntax for deep access.

### Nested Access with `get()`

Type-safe chaining through known keys:

```typescript
p.metadata.get("theme").eq("dark")
p.settings.get("notifications").get("email").eq(true)
```

`get()` returns a typed field builder — if the nested field is a string you get string predicates,
if it's a number you get number predicates, and so on.

### Nested Access with `field()`

Access nested fields by JSON Pointer path:

```typescript
p.config.field("/settings/theme").eq("dark")
p.config.field(["settings", "theme"]).eq("dark")  // Array form
```

Like `get()`, `field()` returns a typed field builder for the resolved path. Use `field()` when
you need to reach deeply nested paths in a single call.

### Key Existence

```typescript
p.metadata.hasKey("theme")                   // Has top-level key
```

### Path Operations

```typescript
p.config.hasPath("/nested/key")              // Has nested path
p.config.pathEquals("/settings/theme", "dark")  // Value at path equals scalar
p.config.pathContains("/tags", "featured")   // Array at path contains value
p.config.pathIsNull("/optional")             // Value at path is null
p.config.pathIsNotNull("/required")          // Value at path is not null
```

### Reference

| Predicate | Accepts | Description |
|-----------|---------|-------------|
| `get(key)` | `string` (key name) | Access nested field, returns typed field builder |
| `field(pointer)` | `string \| string[]` (JSON Pointer) | Access field by path, returns typed field builder |
| `hasKey(key)` | `string` | Has top-level key |
| `hasPath(pointer)` | `string \| string[]` | Has nested path |
| `pathEquals(pointer, value)` | pointer + `string \| number \| boolean \| Date` | Value at path equals scalar |
| `pathContains(pointer, value)` | pointer + `string \| number \| boolean \| Date` | Array at path contains value |
| `pathIsNull(pointer)` | `string \| string[]` | Value at path is null |
| `pathIsNotNull(pointer)` | `string \| string[]` | Value at path is not null |

> **JSON Pointer syntax:** Use `/key/nested/value` string form or `["key", "nested", "value"]`
> array form. `pathEquals` only works on scalar values (not objects or arrays). `pathContains`
> requires the path to point to an array.

---

## Embedding

Embedding predicates for vector similarity search on embedding fields.

### similarTo()

Find similar vectors using distance metrics:

```typescript
p.embedding.similarTo(queryEmbedding, 10)  // Top 10 similar (cosine)
```

### With Options

```typescript
p.embedding.similarTo(queryEmbedding, 10, {
  metric: "cosine",      // "cosine" | "l2" | "inner_product"
  minScore: 0.8,         // Minimum similarity threshold
})
```

### Reference

| Predicate | Accepts | Description |
|-----------|---------|-------------|
| `similarTo(embedding, k)` | `number[], number` | Top k most similar vectors (cosine) |
| `similarTo(embedding, k, opts)` | `number[], number, SimilarToOptions` | Top k with custom metric and threshold |

### Distance Metrics

| Metric | Description | Range | Default | Best For |
|--------|-------------|-------|---------|----------|
| `cosine` | Cosine similarity | 0–1 (1 = identical) | Yes | Normalized embeddings, semantic similarity |
| `l2` | Euclidean distance | 0–∞ (0 = identical) | | Absolute distances, unnormalized vectors |
| `inner_product` | Inner product (PostgreSQL only) | -∞ to ∞ | | Maximum Inner Product Search (MIPS) |

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

> **Limitations:** Results are automatically ordered by similarity (most similar first).
> `similarTo` cannot be nested under `OR` or `NOT`. SQLite does not support embeddings —
> vector search requires PostgreSQL with pgvector.

---

## Parameterized Predicates

Use `param(name)` to create a named placeholder for [prepared queries](/queries/execute#prepared-queries).

```typescript
import { param } from "@nicia-ai/typegraph";

const prepared = store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq(param("name")))
  .select((ctx) => ctx.p)
  .prepare();

const results = await prepared.execute({ name: "Alice" });
```

### Supported Positions

| Position | Supported | Example |
|----------|-----------|---------|
| Scalar comparisons (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`) | Yes | `p.age.gt(param("minAge"))` |
| `between` bounds | Yes | `p.age.between(param("lo"), param("hi"))` |
| String operations (`contains`, `startsWith`, `endsWith`, `like`, `ilike`) | Yes | `p.name.contains(param("search"))` |
| `in` / `notIn` | No | Array length must be known at compile time |
| Array predicates | No | — |
| Subquery predicates | No | — |

See [Prepared Queries](/queries/execute#prepared-queries) for full usage and performance details.

## Next Steps

- [Filter](/queries/filter) — Using predicates in queries
- [Subqueries](/queries/advanced) — `exists()`, `notExists()`, `inSubquery()`, `notInSubquery()`
- [Overview](/queries/overview) — Query builder categories
