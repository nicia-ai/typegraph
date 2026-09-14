---
title: Recursive Traversals
description: Variable-length path traversals with recursive()
---

Graph queries often need to follow edges to an unknown depth: find all ancestors in a hierarchy, all
transitive dependencies of a package, or everyone reachable within six degrees of separation. In a
relational database, each depth level requires another self-join — and you have to know the depth
ahead of time. Recursive traversals solve this by walking edges until a stopping condition is met.

When the backend advertises recursive traversal support, TypeGraph compiles `.recursive()` into a
SQL `WITH RECURSIVE` CTE. The database engine handles the iteration, so you get the full
performance of native recursive SQL without writing it by hand.

## Backend Support

The bundled SQLite and PostgreSQL backends support recursive traversal. A custom backend that
cannot compute a bounded transitive closure in one round trip must declare:

```typescript
const capabilities = {
  recursiveTraversal: {
    supported: false,
    reason: "engine has no WITH RECURSIVE or graph-native equivalent",
  },
} satisfies Partial<BackendCapabilities>;
```

Calling `.recursive()` through that backend throws `ConfigurationError` with
`details.code: "RECURSIVE_TRAVERSAL_UNSUPPORTED"`. `details.operation` identifies the refusing
query path and `details.reason` contains the backend's declaration. This refusal also applies when
the recursive query is nested inside `union()`, `intersect()`, or `except()`.

An absent `recursiveTraversal` declaration means supported for backward compatibility with custom
backends that already execute recursive SQL. See
[Recursive traversal capability](/backend-setup#recursive-traversal-capability) for the complete
backend-author contract and the other operations governed by this capability.

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

| Option        | Type                                                              | Default     | Description                                      |
| ------------- | ----------------------------------------------------------------- | ----------- | ------------------------------------------------ |
| `minHops`     | `number`                                                          | `1`         | Minimum traversal depth before including results |
| `maxHops`     | `number`                                                          | `10`*       | Maximum traversal depth                          |
| `cyclePolicy` | `"prevent" \| "allow"`                                            | `"prevent"` | How to handle cycles                             |
| `depth`       | `boolean \| string`                                               | —           | Expose hop count in `select()` context           |
| `path`        | `boolean \| string \| { format: "qualified"; alias?: string }` | —           | Expose an ID or qualified path                   |

*When `maxHops` is omitted, an implicit cap of 10 is applied. See [Depth Limits](#depth-limits).

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
Pass a string to control the property name. Pass `true` to derive the default name from the target
alias: `${targetAlias}_depth` or `${targetAlias}_path`.

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
    level: ctx.level, // 1 = direct report, 2 = skip-level, etc.
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
    trail: ctx.trail, // Array of node IDs from start to ancestor
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
    distance: ctx.distance, // number
    route: ctx.route, // string[] of node IDs
  }))
  .execute();
```

For a path that identifies both nodes and traversed edges, request the qualified format:

```typescript
const routes = await store
  .query()
  .from("Person", "person")
  .traverse("knows", "connection")
  .recursive({
    maxHops: 4,
    path: { alias: "route", format: "qualified" },
  })
  .to("Person", "friend")
  .select((ctx) => ctx.route)
  .execute();
```

Each route alternates node and edge references, starting and ending with a node:

```typescript
[
  { type: "node", kind: "Person", id: "alice" },
  { type: "edge", kind: "knows", id: "edge-1", direction: "out" },
  { type: "node", kind: "Person", id: "bob" },
];
```

`direction` records how the edge was followed relative to its stored endpoints: `"out"` follows
`from` to `to`, while `"in"` follows `to` to `from`. Qualified paths contain references only; they
do not hydrate node or edge properties. Legacy `path: true` and `path: "alias"` continue to return
node ID arrays.

## Chaining Fixed and Recursive Traversals

Fixed-hop and recursive traversals compose from left to right. Each later stage expands from the
completed identities produced by its `from` alias, then rejoins those results to the earlier rows.
This preserves upstream multiplicity while avoiding repeated expansion of the same `(kind, id)`
source within a stage.

```typescript
const routes = await store
  .query()
  .from("Person", "root")
  .traverse("manages", "management")
  .recursive({ maxHops: 3, depth: "managementDepth" })
  .to("Person", "manager")
  .traverse("worksAt", "employment", { from: "manager" })
  .recursive({ maxHops: 2, path: "organizationPath" })
  .to("Organization", "organization")
  .where((expr) => expr.organization.active.eq(true))
  .orderBy("organization", "name")
  .limit(20)
  .select((ctx) => ({
    manager: ctx.manager.name,
    organization: ctx.organization.name,
    managementDepth: ctx.managementDepth,
    organizationPath: ctx.organizationPath,
  }))
  .execute();
```

The `minHops`, `maxHops`, `cyclePolicy`, `stopExpansion`, `path`, and `depth` settings apply to
their own recursive stage. An `optionalTraverse()`, including the first stage, retains the earlier row
when it finds no match; its target, path, and depth values are `undefined`. A completed `.where()`,
final ordering, and final limit apply after every stage. The `from` option may also branch from any
earlier materialized node alias.

### Mixing fixed hops with recursion

A fixed hop can precede or follow recursion. Fixed-hop edges retain their ordinary property bindings;
recursive edges are represented by path references.

```typescript
const reports = await store.query()
  .from("Person", "root")
  .traverse("manages", "directManagement")
  .to("Person", "directReport")
  .traverse("manages", "management")
  .recursive({ minHops: 0, maxHops: 3, depth: "depth" })
  .to("Person", "report")
  .traverse("worksAt", "employment")
  .to("Organization", "organization")
  .select((ctx) => ({
    report: ctx.report.name,
    organization: ctx.organization.name,
    employment: ctx.employment,
    depth: ctx.depth,
  }))
  .execute();
```

### An optional first recursive stage

Use `optionalTraverse()` before `.recursive()` to retain roots that have no eligible endpoint.
With a positive `minHops`, a root with no matching path returns `undefined` for its target, depth,
and path. With `minHops: 0`, an eligible root is a real zero-hop match: depth `0` and a one-node
path. Endpoint eligibility includes `stopExpansion()` and its `emitStopNode` setting.

Match constraints can remove every endpoint while retaining the optional row. A completed `.where()`
comparison against the absent target removes that row unless its predicate explicitly allows absence.
A subsequent required traversal from an absent target produces no match; a subsequent optional traversal
preserves absence. You can still branch from a present earlier alias using the `from` option.

### Boolean shorthand

Pass `true` instead of a string to derive output names from the target alias:

```typescript
.recursive({ depth: true, path: true })
.to("Person", "target")
// ctx.target_depth and ctx.target_path are available in select()
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
  .recursive() // cyclePolicy: "prevent" is the default
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
hits `maxHops`. If `maxHops` is not set, the implicit cap of 10 prevents infinite recursion,
but you may get many duplicate results.
:::

## Expansion and completed-result filters

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

Use `.where()` to filter completed matches without pruning intermediate nodes. In this example,
inactive intermediate nodes can still lead to an active endpoint:

```typescript
const activeEndpoints = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("knows", "e")
  .recursive({ maxHops: 5 })
  .to("Person", "connection")
  .where((fields) => expr.eq(fields.connection.active, expr.literal(true)))
  .select((ctx) => ctx.connection.name)
  .execute();
```

`whereNode("connection", ...)` is an every-hop constraint. `.where(...)` is an endpoint/result
constraint applied after recursive expansion and the minimum-depth check.

## Stop expansion at a boundary

`stopExpansion()` prevents a matching endpoint from becoming the next recursive frontier. The
stopping node is included by default:

```typescript
const managersThroughDirectors = await store
  .query()
  .from("Person", "employee")
  .traverse("reportsTo", "edge")
  .recursive({ maxHops: 10 })
  .to("Person", "manager")
  .stopExpansion("manager", (manager) => manager.role.eq("Director"))
  .select((ctx) => ctx.manager.name)
  .execute();
```

This emits the matching director but does not follow that director's outgoing `reportsTo` edge.
Pass `{ emitStopNode: false }` to omit the director as well:

```typescript
.stopExpansion(
  "manager",
  (manager) => manager.role.eq("Director"),
  { emitStopNode: false },
)
```

A stop predicate can use ordinary fields from the recursive target alias. Subqueries, aggregate
predicates, ranked search predicates, and fields from other aliases are refused. Only the matching
branch stops; other recursive branches continue. With `minHops: 0`, the source node is also the
depth-zero target, so a matching source is emitted or omitted according to `emitStopNode` and its
branch does not expand. SQL `NULL` does not stop a branch.

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

| Constant                       | Value | When it applies                    |
| ------------------------------ | ----- | ---------------------------------- |
| `MAX_RECURSIVE_DEPTH`          | 10    | `maxHops` is omitted               |
| `MAX_EXPLICIT_RECURSIVE_DEPTH` | 1000  | Upper bound for explicit `maxHops` |

Graphs with branching factor *B* produce O(*B*^depth) rows before cycle detection
can prune them. The default of 10 covers typical neighborhood, shortest-path, and
hierarchy queries without risking exponential blowup on dense graphs. Pass
`maxHops` to `.recursive({ maxHops: N })` to opt in to deeper traversals when you know
the graph structure.

```typescript
import {
  MAX_EXPLICIT_RECURSIVE_DEPTH,
  MAX_RECURSIVE_DEPTH,
} from "@nicia-ai/typegraph";

.recursive()                  // Implicitly capped at 10
.recursive({ maxHops: 50 })   // Honored (≤ 1000)
.recursive({ maxHops: 2000 }) // Refused before SQL compilation
```

:::note[Breaking change in v0.14]
The default depth was lowered from 100 to 10. If your traversals relied on the
implicit 100-hop cap, add `.recursive({ maxHops: 100 })`.
:::

## Limitations

- **Match predicates in a staged query can reference only the alias they constrain.** Cross-alias match
  predicates are refused before execution. Use completed-row `.where()` for comparisons between aliases;
  remember that a completed-row comparison can remove an unmatched optional row.

- **Recursive queries cannot be aggregated in place yet.** `groupBy()`, aggregate projections,
  aggregate ordering, and `having()` are refused. Project node columns with `project()`, then use
  `asRelation()` to aggregate that completed relation.
- **Recursive edge properties are not projected.** You can filter them with `whereEdge()`. Fixed-hop
  edge properties remain selectable when fixed hops and recursion appear in the same query.
- **Recursive edges are not materialized in the result.** Qualified paths expose edge references,
  but selected recursive edge fields are refused.

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
