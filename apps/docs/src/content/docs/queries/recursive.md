---
title: Recursive Traversals
description: Variable-length path traversals with recursive()
---

Graph queries often need to follow edges to an unknown depth: find all ancestors in a hierarchy, all
transitive dependencies of a package, or everyone reachable within six degrees of separation. In a
relational database, each depth level requires another self-join — and you have to know the depth
ahead of time. Recursive traversals solve this by walking edges until a stopping condition is met.

TypeGraph compiles `.recursive()` into a SQL `WITH RECURSIVE` CTE. The database engine handles the
iteration, so you get the full performance of native recursive SQL without writing it by hand.

## How It Works

A recursive traversal starts from a set of source nodes and repeatedly follows edges, accumulating
results at each level:

```text
Level 0:  Alice
            │ reportsTo
Level 1:  Bob
            │ reportsTo
Level 2:  Carol
            │ reportsTo
Level 3:  Dana (CEO)
```

With `.recursive()`, a single query returns Bob, Carol, and Dana — regardless of how deep the chain
goes. Without it, you'd need to know there are exactly 3 levels and chain 3 traversals manually.

## Basic Usage

Add `.recursive()` between `.traverse()` and `.to()`:

```typescript
const allManagers = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("reportsTo", "e")
  .recursive()
  .to("Person", "manager")
  .select((ctx) => ({
    employee: ctx.p.name,
    manager: ctx.manager.name,
  }))
  .execute();

// Returns every manager above Alice, at any depth
```

## Options Reference

```typescript
.recursive(options?)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `minHops` | `number` | `1` | Minimum traversal depth before including results |
| `maxHops` | `number` | `100`* | Maximum traversal depth |
| `cyclePolicy` | `"prevent" \| "allow"` | `"prevent"` | How to handle cycles |
| `depth` | `boolean \| string` | — | Expose hop count in `select()` context |
| `path` | `boolean \| string` | — | Expose node ID path in `select()` context |

*When `maxHops` is omitted, an implicit cap of 100 is applied. See [Depth Limits](#depth-limits).

## Controlling Depth

### maxHops

Cap the traversal depth:

```typescript
const nearbyManagers = await store
  .query()
  .from("Person", "p")
  .traverse("reportsTo", "e")
  .recursive({ maxHops: 3 })
  .to("Person", "manager")
  .select((ctx) => ({
    employee: ctx.p.name,
    manager: ctx.manager.name,
  }))
  .execute();
```

### minHops

Skip nearby results. With `minHops: 2`, direct connections (1 hop) are excluded:

```typescript
const distantConnections = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("knows", "e")
  .recursive({ minHops: 2 })
  .to("Person", "friend")
  .select((ctx) => ({
    person: ctx.p.name,
    distantFriend: ctx.friend.name,
  }))
  .execute();
```

### Combining minHops and maxHops

```typescript
// Friends-of-friends: 2–4 hops away
.recursive({ minHops: 2, maxHops: 4 })
```

`minHops` must be ≤ `maxHops` when both are specified.

## Tracking Depth and Path

When `depth` or `path` are enabled, they become available as properties on the `select()` context.
Pass a string to control the property name; pass `true` to use the default names (`"depth"` and
`"path"`).

### depth

Expose the hop count as a number in each result row:

```typescript
const orgChart = await store
  .query()
  .from("Person", "ceo")
  .whereNode("ceo", (p) => p.role.eq("CEO"))
  .traverse("manages", "e")
  .recursive({ depth: "level" })
  .to("Person", "employee")
  .select((ctx) => ({
    ceo: ctx.ceo.name,
    employee: ctx.employee.name,
    level: ctx.level,             // 1 = direct report, 2 = skip-level, etc.
  }))
  .execute();
```

The string `"level"` passed to `depth` becomes `ctx.level` in the select callback — TypeScript
infers this automatically, so `ctx.level` is fully typed.

### path

Expose the traversal path as an array of node IDs:

```typescript
const pathsToRoot = await store
  .query()
  .from("Category", "cat")
  .whereNode("cat", (c) => c.name.eq("Electronics"))
  .traverse("parentCategory", "e")
  .recursive({ path: "trail" })
  .to("Category", "ancestor")
  .select((ctx) => ({
    category: ctx.cat.name,
    ancestor: ctx.ancestor.name,
    trail: ctx.trail,             // Array of node IDs from start to ancestor
  }))
  .execute();
```

### Using both together

```typescript
const networkAnalysis = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("knows", "e")
  .recursive({
    maxHops: 6,
    depth: "distance",
    path: "route",
  })
  .to("Person", "connection")
  .select((ctx) => ({
    person: ctx.p.name,
    connection: ctx.connection.name,
    distance: ctx.distance,       // number
    route: ctx.route,             // string[] of node IDs
  }))
  .execute();
```

### Boolean shorthand

Pass `true` instead of a string to use the default alias names:

```typescript
.recursive({ depth: true, path: true })
// ctx.depth and ctx.path are available in select()
```

## Cycle Detection

Graphs often contain cycles: `A → B → C → A`. Without protection, a recursive traversal on this
graph would loop forever.

### cyclePolicy: "prevent" (default)

The default policy tracks visited nodes per path and stops when a node would be visited twice.
This is safe for any graph topology:

```typescript
// Safe even with circular relationships (A → B → C → A)
const allReachable = await store
  .query()
  .from("Node", "start")
  .traverse("linkedTo", "e")
  .recursive()                    // cyclePolicy: "prevent" is the default
  .to("Node", "reachable")
  .select((ctx) => ctx.reachable.id)
  .execute();
```

Under the hood, the compiled SQL maintains a path structure at each recursive step and checks
whether the next node has already been visited. On PostgreSQL this uses `ARRAY` operations; on
SQLite it uses string-delimited path tracking.

### cyclePolicy: "allow"

Skips cycle checking entirely. The traversal relies solely on `maxHops` to terminate. Use this when:

- You know your graph is acyclic (trees, DAGs)
- You want maximum query performance and accept that nodes may appear multiple times
- You're using a strict `maxHops` that prevents runaway recursion

```typescript
// Tree structure — no cycles possible
const ancestors = await store
  .query()
  .from("Category", "cat")
  .traverse("parentCategory", "e")
  .recursive({ maxHops: 20, cyclePolicy: "allow" })
  .to("Category", "ancestor")
  .select((ctx) => ctx.ancestor.name)
  .execute();
```

:::caution
With `cyclePolicy: "allow"` on a cyclic graph, the traversal **will** revisit nodes until it
hits `maxHops`. If `maxHops` is not set, the implicit cap of 100 prevents infinite recursion,
but you may get many duplicate results.
:::

## Filtering During Recursion

Predicates placed on the target node or edge apply **at every step** of the recursion — not just
the final results. This lets you prune paths early:

```typescript
// Only follow "active" edges and land on "active" nodes
const activeNetwork = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("knows", "e")
  .whereEdge("e", (e) => e.status.eq("active"))
  .recursive({ maxHops: 5 })
  .to("Person", "connection")
  .whereNode("connection", (c) => c.active.eq(true))
  .select((ctx) => ctx.connection.name)
  .execute();
```

Source node predicates (on `"p"` above) apply only to the starting set. Edge and target node
predicates are included in the recursive CTE, so unreachable branches are pruned at each level
rather than filtered after the fact.

## Duplicate Results

When a node is reachable via multiple paths, it appears once per path:

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

// Returns: ["B", "D", "C", "D"] — D appears twice (once per path)
```

To get unique nodes, deduplicate in your application or use [set operations](/queries/combine).

## Depth Limits

Two safety caps prevent runaway recursion:

| Constant | Value | When it applies |
|----------|-------|-----------------|
| `MAX_RECURSIVE_DEPTH` | 100 | `maxHops` is omitted |
| `MAX_EXPLICIT_RECURSIVE_DEPTH` | 1000 | Upper bound for explicit `maxHops` |

```typescript
import {
  MAX_EXPLICIT_RECURSIVE_DEPTH,
  MAX_RECURSIVE_DEPTH,
} from "@nicia-ai/typegraph";

.recursive()                  // Implicitly capped at 100
.recursive({ maxHops: 500 })  // Honored (≤ 1000)
.recursive({ maxHops: 2000 }) // Throws UnsupportedPredicateError
```

## Limitations

- **One recursive traversal per query.** A query with multiple `.recursive()` calls throws
  `UnsupportedPredicateError`. If you need multiple recursive paths, run separate queries or
  use [set operations](/queries/combine) to merge results.
- **Edge properties are not projected** in recursive results. You can filter on edge properties
  with `whereEdge()`, but the `select()` context only exposes the start node, target node, and
  any depth/path aliases.

## Real-World Examples

### Organizational Hierarchy

Find all reports (direct and indirect) under a manager:

```typescript
const allReports = await store
  .query()
  .from("Person", "manager")
  .whereNode("manager", (p) => p.name.eq("VP Engineering"))
  .traverse("manages", "e")
  .recursive({ depth: "level" })
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
  .recursive({ path: "chain", depth: "depth" })
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

### Social Network — Friends of Friends

```typescript
const recommendations = await store
  .query()
  .from("Person", "me")
  .whereNode("me", (p) => p.id.eq(currentUserId))
  .traverse("follows", "e")
  .recursive({ minHops: 2, maxHops: 3 })
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
  .recursive({ path: "pathIds", depth: "depth" })
  .to("Category", "ancestor")
  .select((ctx) => ({
    name: ctx.ancestor.name,
    slug: ctx.ancestor.slug,
    depth: ctx.depth,
  }))
  .orderBy("depth", "desc")
  .execute();

// Returns: [{ name: "Root", depth: 3 }, { name: "Electronics", depth: 2 }, { name: "Phones", depth: 1 }]
```

### Access Control — Permission Inheritance

Check if a user has access through a group hierarchy:

```typescript
const inheritedPermissions = await store
  .query()
  .from("Group", "group")
  .whereNode("group", (g) => g.name.eq("Engineering"))
  .traverse("parentGroup", "e")
  .recursive({ depth: "level", maxHops: 10 })
  .to("Group", "ancestor")
  .select((ctx) => ({
    group: ctx.ancestor.name,
    level: ctx.level,
  }))
  .execute();

// Returns: [{ group: "Product", level: 1 }, { group: "Company", level: 2 }]
// Alice inherits permissions from Engineering → Product → Company
```

## Next Steps

- [Traverse](/queries/traverse) — Single-hop and multi-hop traversals
- [Filter](/queries/filter) — Filter nodes and edges with predicates
- [Shape](/queries/shape) — Transform output with `select()`
- [Combine](/queries/combine) — Merge results from multiple queries
