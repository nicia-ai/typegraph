---
title: Recursive
description: Variable-length paths with recursive(), maxHops(), minHops()
---

Recursive traversals follow edges of unknown depth—find all ancestors, all reachable nodes, or paths within a certain distance.

## Basic Recursive Traversal

Use `.recursive()` after a traversal to enable variable-length paths:

```typescript
const allManagers = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("reportsTo", "e")
  .recursive()                    // Enable variable-length traversal
  .to("Person", "manager")
  .select((ctx) => ({
    employee: ctx.p.name,
    manager: ctx.manager.name,
  }))
  .execute();

// Returns all managers above Alice in the hierarchy
```

## Controlling Depth

### maxHops()

Limit the maximum traversal depth:

```typescript
const nearbyManagers = await store
  .query()
  .from("Person", "p")
  .traverse("reportsTo", "e")
  .recursive()
  .maxHops(3)                     // At most 3 levels up
  .to("Person", "manager")
  .select((ctx) => ({
    employee: ctx.p.name,
    manager: ctx.manager.name,
  }))
  .execute();
```

### minHops()

Skip nearby nodes and only include results beyond a minimum distance:

```typescript
const distantConnections = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("knows", "e")
  .recursive()
  .minHops(2)                     // Skip direct connections
  .to("Person", "friend")
  .select((ctx) => ({
    person: ctx.p.name,
    distantFriend: ctx.friend.name,
  }))
  .execute();

// Returns friends-of-friends and beyond, not direct connections
```

### Combining minHops and maxHops

```typescript
const networkAnalysis = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("knows", "e")
  .recursive()
  .minHops(2)                     // At least 2 hops away
  .maxHops(4)                     // At most 4 hops away
  .to("Person", "connection")
  .select((ctx) => ctx.connection.name)
  .execute();
```

## Collecting Path Information

### collectPath()

Include the traversal path as an array in results:

```typescript
const pathsToRoot = await store
  .query()
  .from("Category", "cat")
  .whereNode("cat", (c) => c.name.eq("Electronics"))
  .traverse("parentCategory", "e")
  .recursive()
  .collectPath("categoryPath")    // Include path as array
  .to("Category", "ancestor")
  .select((ctx) => ({
    category: ctx.cat.name,
    ancestor: ctx.ancestor.name,
    path: ctx.categoryPath,       // Array of node IDs in the path
  }))
  .execute();
```

### withDepth()

Include the traversal depth as a column:

```typescript
const orgChart = await store
  .query()
  .from("Person", "ceo")
  .whereNode("ceo", (p) => p.role.eq("CEO"))
  .traverse("manages", "e")
  .recursive()
  .withDepth("level")             // Include depth as column
  .to("Person", "employee")
  .select((ctx) => ({
    ceo: ctx.ceo.name,
    employee: ctx.employee.name,
    level: ctx.level,             // 1 = direct report, 2 = skip-level, etc.
  }))
  .execute();
```

### Combining All Options

```typescript
const networkAnalysis = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("knows", "e")
  .recursive()
  .minHops(1)
  .maxHops(6)                     // Six degrees of separation
  .collectPath("path")
  .withDepth("distance")
  .to("Person", "connection")
  .select((ctx) => ({
    person: ctx.p.name,
    connection: ctx.connection.name,
    distance: ctx.distance,
    path: ctx.path,
  }))
  .execute();
```

## Cycle Detection

Recursive traversals automatically detect and prevent cycles. The same node will not be visited twice in any path:

```typescript
// Safe even with circular relationships (A → B → C → A)
const allReachable = await store
  .query()
  .from("Node", "start")
  .traverse("linkedTo", "e")
  .recursive()
  .to("Node", "reachable")
  .select((ctx) => ctx.reachable.id)
  .execute();
```

## Duplicate Results

When a node is reachable via multiple paths, it may appear multiple times. Each result represents a distinct path:

```typescript
// Graph: A → B → D, A → C → D (D is reachable via two paths)
const results = await store
  .query()
  .from("Node", "start")
  .whereNode("start", (n) => n.name.eq("A"))
  .traverse("linkedTo", "e")
  .recursive()
  .to("Node", "reachable")
  .select((ctx) => ctx.reachable.name)
  .execute();

// Returns: ["B", "D", "C", "D"] - D appears twice (once via B, once via C)
```

To get unique nodes, deduplicate in your application or use [set operations](/queries/combine).

## Depth Limits

Variable-length traversals have a maximum depth of 100 hops, even when no `maxHops()` is specified:

```typescript
import { MAX_RECURSIVE_DEPTH } from "@nicia-ai/typegraph";
// MAX_RECURSIVE_DEPTH = 100

// Explicit limits are capped at 100
.recursive()
.maxHops(200)  // Silently capped to 100
```

## Real-World Examples

### Organizational Hierarchy

Find all reports (direct and indirect) under a manager:

```typescript
const allReports = await store
  .query()
  .from("Person", "manager")
  .whereNode("manager", (p) => p.name.eq("VP Engineering"))
  .traverse("manages", "e")
  .recursive()
  .withDepth("level")
  .to("Person", "report")
  .select((ctx) => ({
    manager: ctx.manager.name,
    report: ctx.report.name,
    level: ctx.level,
    department: ctx.report.department,
  }))
  .orderBy("level", "asc")
  .execute();
```

### Dependency Graph

Find all transitive dependencies of a package:

```typescript
const dependencies = await store
  .query()
  .from("Package", "pkg")
  .whereNode("pkg", (p) => p.name.eq("my-app"))
  .traverse("dependsOn", "e")
  .recursive()
  .collectPath("chain")
  .withDepth("depth")
  .to("Package", "dep")
  .select((ctx) => ({
    package: ctx.pkg.name,
    dependency: ctx.dep.name,
    version: ctx.dep.version,
    depth: ctx.depth,
    chain: ctx.chain,
  }))
  .orderBy("depth", "asc")
  .execute();
```

### Social Network - Friends of Friends

```typescript
const recommendations = await store
  .query()
  .from("Person", "me")
  .whereNode("me", (p) => p.id.eq(currentUserId))
  .traverse("follows", "e")
  .recursive()
  .minHops(2)                     // Not direct follows
  .maxHops(3)                     // But not too distant
  .to("Person", "suggestion")
  .select((ctx) => ({
    id: ctx.suggestion.id,
    name: ctx.suggestion.name,
  }))
  .limit(20)
  .execute();
```

### Category Breadcrumbs

```typescript
const breadcrumbs = await store
  .query()
  .from("Category", "current")
  .whereNode("current", (c) => c.slug.eq("smartphones"))
  .traverse("parentCategory", "e")
  .recursive()
  .collectPath("pathIds")
  .withDepth("depth")
  .to("Category", "ancestor")
  .select((ctx) => ({
    name: ctx.ancestor.name,
    slug: ctx.ancestor.slug,
    depth: ctx.depth,
  }))
  .orderBy("depth", "desc")  // Root first
  .execute();

// Returns: [{ name: "Root", depth: 3 }, { name: "Electronics", depth: 2 }, { name: "Phones", depth: 1 }]
```

## Next Steps

- [Traverse](/queries/traverse) - Single-hop and multi-hop traversals
- [Filter](/queries/filter) - Filter nodes and edges
- [Shape](/queries/shape) - Transform output with `select()`
