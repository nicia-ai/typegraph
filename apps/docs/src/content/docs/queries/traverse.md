---
title: Traverse
description: Navigate relationships with traverse() and optionalTraverse()
---

Traversals let you navigate relationships in your graph. Instead of writing complex SQL joins,
describe the path you want to follow.

## Single-Hop Traversal

Follow one edge from a node to connected nodes:

```typescript
const employments = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.id.eq("alice-123"))
  .traverse("worksAt", "e")      // Follow worksAt edges
  .to("Company", "c")            // Arrive at Company nodes
  .select((ctx) => ({
    person: ctx.p.name,
    company: ctx.c.name,
    role: ctx.e.role,            // Edge properties are accessible
  }))
  .execute();
```

## Parameters

### traverse()

```typescript
.traverse(edgeKind, edgeAlias, options?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `edgeKind` | `string` | The edge kind to traverse |
| `edgeAlias` | `string` | Unique alias for referencing this edge |
| `options.direction` | `"out" \| "in"` | Traversal direction (default: `"out"`) |
| `options.expand` | `"none" \| "implying" \| "inverse" \| "all"` | Ontology edge expansion mode (default: `"inverse"`) |
| `options.from` | `string` | Fan-out from a different node alias |

### optionalTraverse()

```typescript
.optionalTraverse(edgeKind, edgeAlias, options?)
```

Uses the same options as `traverse()`, but returns optional edge/node values in the result context.

### to()

```typescript
.to(nodeKind, nodeAlias, options?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `nodeKind` | `string` | The target node kind |
| `nodeAlias` | `string` | Unique alias for referencing this node |
| `options.includeSubClasses` | `boolean` | Include subclass kinds (default: `false`) |

## Direction

By default, traversals follow edges in their defined direction (from → to). Use `direction: "in"` to traverse backwards:

```typescript
// Edge definition: worksAt goes from Person → Company

// Forward: Find companies where Alice works
.from("Person", "p")
.traverse("worksAt", "e")           // Person → Company
.to("Company", "c")

// Backward: Find people who work at Acme
.from("Company", "c")
.whereNode("c", (c) => c.name.eq("Acme"))
.traverse("worksAt", "e", { direction: "in" })  // Company ← Person
.to("Person", "p")
```

## Edge Properties

Edges can carry properties. Access them through the edge alias:

```typescript
const employments = await store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e")
  .to("Company", "c")
  .select((ctx) => ({
    person: ctx.p.name,
    company: ctx.c.name,
    role: ctx.e.role,           // Edge property
    salary: ctx.e.salary,       // Edge property
    startDate: ctx.e.startDate, // Edge property
  }))
  .execute();
```

### Edge Object Structure

Each edge provides these fields:

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique edge identifier |
| `kind` | `string` | Edge type name |
| `fromId` | `string` | ID of the source node |
| `toId` | `string` | ID of the target node |
| `meta.createdAt` | `string` | When the edge was created |
| `meta.updatedAt` | `string` | When the edge was last updated |
| `meta.deletedAt` | `string \| undefined` | Soft delete timestamp |
| `meta.validFrom` | `string \| undefined` | Temporal validity start |
| `meta.validTo` | `string \| undefined` | Temporal validity end |
| *schema props* | varies | Properties defined in edge schema |

### Filtering on Edge Properties

Use `whereEdge()` to filter based on edge values:

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

## Multi-Hop Traversals

Chain traversals to follow multiple relationships:

```typescript
const projectTasks = await store
  .query()
  .from("Person", "person")
  .whereNode("person", (p) => p.name.eq("Alice"))
  .traverse("worksOn", "e1")
  .to("Project", "project")
  .traverse("hasTask", "e2")
  .to("Task", "task")
  .select((ctx) => ({
    person: ctx.person.name,
    project: ctx.project.name,
    task: ctx.task.title,
  }))
  .execute();
```

Each hop starts from the previous node set and arrives at new nodes.

### Mixed Directions

Combine forward and backward traversals:

```typescript
const teamStructure = await store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e1")                      // Forward: Person → Company
  .to("Company", "c")
  .traverse("manages", "e2", { direction: "in" }) // Backward: Person ← manages
  .to("Person", "manager")
  .select((ctx) => ({
    employee: ctx.p.name,
    company: ctx.c.name,
    manager: ctx.manager.name,
  }))
  .execute();
```

## Optional Traversals

Use `optionalTraverse()` for LEFT JOIN semantics—include results even when the traversal has no matches:

```typescript
const peopleWithOptionalEmployer = await store
  .query()
  .from("Person", "p")
  .optionalTraverse("worksAt", "e")
  .to("Company", "c")
  .select((ctx) => ({
    person: ctx.p.name,
    company: ctx.c?.name,  // May be undefined if no employer
  }))
  .execute();

// Includes all people, even those without a worksAt edge
```

### Mixing Required and Optional

```typescript
const employeesWithOptionalManager = await store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e1")              // Required: must work at a company
  .to("Company", "c")
  .optionalTraverse("reportsTo", "e2")    // Optional: might not have manager
  .to("Person", "manager")
  .select((ctx) => ({
    employee: ctx.p.name,
    company: ctx.c.name,
    manager: ctx.manager?.name,           // undefined for top-level employees
  }))
  .execute();
```

### Optional Edge Access

With optional traversals, the edge may be `undefined`:

```typescript
.select((ctx) => ({
  person: ctx.p.name,
  company: ctx.c?.name,      // Node may be undefined
  role: ctx.e?.role,         // Edge may be undefined
  salary: ctx.e?.salary,
}))
```

## Ontology-Aware Traversals

If your ontology defines edge implications, expand queries to include implying edges:

```typescript
// Ontology: implies(marriedTo, knows), implies(bestFriends, knows)

const connections = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("knows", "e", { expand: "implying" })
  .to("Person", "other")
  .select((ctx) => ctx.other.name)
  .execute();

// Returns people connected via "knows", "marriedTo", or "bestFriends"
```

If your ontology defines inverse edge kinds, you can expand traversals to include inverse edges:

```typescript
// Ontology: inverseOf(manages, managedBy)

const relationships = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("manages", "e", { expand: "inverse" })
  .to("Person", "other")
  .select((ctx) => ({
    name: ctx.other.name,
    viaEdgeKind: ctx.e.kind,
  }))
  .execute();

// Traverses both "manages" and "managedBy"
```

You can combine both options:

```typescript
.traverse("knows", "e", { expand: "all" })
```

:::note[Default expansion mode]
The default expansion mode is `"inverse"`, meaning traversals automatically include inverse edge kinds
from your ontology. To opt out for a single traversal, pass `expand: "none"`. To change the default
for all traversals, set `queryDefaults.traversalExpansion` in `createStore` options.
:::

## Real-World Examples

### Organizational Hierarchy

```typescript
const teamMembers = await store
  .query()
  .from("Person", "manager")
  .whereNode("manager", (p) => p.name.eq("VP Engineering"))
  .traverse("manages", "e")
  .to("Person", "report")
  .select((ctx) => ({
    manager: ctx.manager.name,
    report: ctx.report.name,
    department: ctx.report.department,
  }))
  .execute();
```

### Social Graph

```typescript
const friends = await store
  .query()
  .from("Person", "me")
  .whereNode("me", (p) => p.id.eq(currentUserId))
  .traverse("follows", "e")
  .to("Person", "friend")
  .select((ctx) => ({
    id: ctx.friend.id,
    name: ctx.friend.name,
    followedAt: ctx.e.createdAt,
  }))
  .orderBy("e", "createdAt", "desc")
  .limit(50)
  .execute();
```

### E-Commerce

```typescript
const orderDetails = await store
  .query()
  .from("Order", "o")
  .whereNode("o", (o) => o.id.eq(orderId))
  .traverse("contains", "e")
  .to("Product", "p")
  .select((ctx) => ({
    product: ctx.p.name,
    quantity: ctx.e.quantity,
    unitPrice: ctx.e.unitPrice,
  }))
  .execute();
```

## Next Steps

- [Recursive](/queries/recursive) - Variable-length paths with `recursive()`
- [Filter](/queries/filter) - Filter nodes and edges with predicates
- [Shape](/queries/shape) - Transform output with `select()`
