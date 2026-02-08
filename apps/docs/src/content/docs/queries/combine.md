---
title: Combine
description: Set operations with union(), intersect(), and except()
---

Combine operations merge results from multiple queries using set operations. Use `union()` to combine
results, `intersect()` to find common results, and `except()` to exclude results.

## Set Operations Overview

| Operation | Description | Duplicates |
|-----------|-------------|------------|
| `union()` | Combine results from both queries | Removed |
| `unionAll()` | Combine results from both queries | Kept |
| `intersect()` | Results that appear in both queries | Removed |
| `except()` | Results in first query but not second | Removed |

## union()

Combine results from multiple queries, removing duplicates:

```typescript
const activeOrAdmin = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
  .union(
    store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.role.eq("admin"))
      .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
  )
  .execute();
```

This returns all active users PLUS all admins, with duplicates removed (active admins appear once).

### Selection Shape Must Match

Both queries must have the same selection shape:

```typescript
// Valid: Same shape
query1.select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
  .union(
    query2.select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
  )

// Invalid: Different shapes - will cause an error
query1.select((ctx) => ({ id: ctx.p.id }))
  .union(
    query2.select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
  )
```

## unionAll()

Combine results keeping duplicates:

```typescript
const allMentions = await store
  .query()
  .from("Comment", "c")
  .whereNode("c", (c) => c.mentions.contains(userId))
  .select((ctx) => ({ id: ctx.c.id, text: ctx.c.text }))
  .unionAll(
    store
      .query()
      .from("Post", "p")
      .whereNode("p", (p) => p.mentions.contains(userId))
      .select((ctx) => ({ id: ctx.p.id, text: ctx.p.content }))
  )
  .execute();
```

Use `unionAll()` when:

- You want to preserve duplicates
- Performance matters (no deduplication overhead)
- You're counting occurrences

## intersect()

Find results that appear in both queries:

```typescript
const activeAdmins = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .select((ctx) => ({ id: ctx.p.id }))
  .intersect(
    store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.role.eq("admin"))
      .select((ctx) => ({ id: ctx.p.id }))
  )
  .execute();
```

This returns only users who are BOTH active AND admins.

### Equivalent to AND

`intersect()` can often be replaced with combined predicates:

```typescript
// Using intersect
query1.intersect(query2)

// Often equivalent to
.whereNode("p", (p) =>
  p.status.eq("active").and(p.role.eq("admin"))
)
```

Use `intersect()` when the queries are complex or involve different traversal paths.

## except()

Find results in the first query but not the second (set difference):

```typescript
const nonAdminActive = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .select((ctx) => ({ id: ctx.p.id }))
  .except(
    store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.role.eq("admin"))
      .select((ctx) => ({ id: ctx.p.id }))
  )
  .execute();
```

This returns active users who are NOT admins.

### Order Matters

Unlike `union()` and `intersect()`, the order of queries in `except()` matters:

```typescript
// Active users who are NOT admins
activeUsers.except(admins)

// Admins who are NOT active (different result!)
admins.except(activeUsers)
```

## Chaining Set Operations

Chain multiple set operations:

```typescript
const complexSet = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .select((ctx) => ({ id: ctx.p.id }))
  .union(
    store.query()
      .from("Person", "p")
      .whereNode("p", (p) => p.role.eq("admin"))
      .select((ctx) => ({ id: ctx.p.id }))
  )
  .except(
    store.query()
      .from("Person", "p")
      .whereNode("p", (p) => p.suspended.eq(true))
      .select((ctx) => ({ id: ctx.p.id }))
  )
  .execute();

// (active OR admin) AND NOT suspended
```

## Ordering and Limiting Combined Results

Apply ordering and limits after set operations:

```typescript
const results = await query1
  .union(query2)
  .orderBy("name", "asc")
  .limit(100)
  .execute();
```

## Real-World Examples

### Multi-Source Search

Search across different node types:

```typescript
async function globalSearch(term: string) {
  const people = store
    .query()
    .from("Person", "p")
    .whereNode("p", (p) => p.name.ilike(`%${term}%`))
    .select((ctx) => ({
      id: ctx.p.id,
      type: "person" as const,
      title: ctx.p.name,
    }));

  const companies = store
    .query()
    .from("Company", "c")
    .whereNode("c", (c) => c.name.ilike(`%${term}%`))
    .select((ctx) => ({
      id: ctx.c.id,
      type: "company" as const,
      title: ctx.c.name,
    }));

  return people
    .union(companies)
    .limit(20)
    .execute();
}
```

### Exclude Blocklist

```typescript
const eligibleUsers = await store
  .query()
  .from("User", "u")
  .whereNode("u", (u) => u.status.eq("active"))
  .select((ctx) => ({ id: ctx.u.id, email: ctx.u.email }))
  .except(
    store
      .query()
      .from("BlockedUser", "b")
      .traverse("blockedUser", "e")
      .to("User", "u")
      .select((ctx) => ({ id: ctx.u.id, email: ctx.u.email }))
  )
  .execute();
```

### Find Common Connections

```typescript
async function mutualFriends(userId1: string, userId2: string) {
  const user1Friends = store
    .query()
    .from("Person", "p")
    .whereNode("p", (p) => p.id.eq(userId1))
    .traverse("follows", "e")
    .to("Person", "friend")
    .select((ctx) => ({ id: ctx.friend.id, name: ctx.friend.name }));

  const user2Friends = store
    .query()
    .from("Person", "p")
    .whereNode("p", (p) => p.id.eq(userId2))
    .traverse("follows", "e")
    .to("Person", "friend")
    .select((ctx) => ({ id: ctx.friend.id, name: ctx.friend.name }));

  return user1Friends
    .intersect(user2Friends)
    .execute();
}
```

### Deduplicate Recursive Results

Remove duplicate nodes from recursive traversals:

```typescript
// Get unique reachable nodes (recursive may return duplicates via different paths)
const uniqueNodes = await store
  .query()
  .from("Node", "start")
  .traverse("linkedTo", "e")
  .recursive()
  .to("Node", "reachable")
  .select((ctx) => ({ id: ctx.reachable.id }))
  .union(
    // Union with empty set to deduplicate (hack)
    store
      .query()
      .from("Node", "n")
      .whereNode("n", (n) => n.id.eq("__nonexistent__"))
      .select((ctx) => ({ id: ctx.n.id }))
  )
  .execute();
```

## Next Steps

- [Advanced](/queries/advanced) - Subqueries with `exists()` and `inSubquery()`
- [Execute](/queries/execute) - Running queries
- [Compose](/queries/compose) - Reusable query fragments
