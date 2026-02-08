---
title: Schemas & Types
description: Defining nodes, edges, and leveraging TypeScript inference
---

TypeGraph's power comes from its type system. Define your schema once with Zod, and get:

- **Runtime validation** on every create and update
- **TypeScript types** inferred automatically (no duplication)
- **Query builder constraints** that prevent invalid queries at compile time

## Contents

- [Nodes](#nodes) — Entities with properties and metadata
  - [Defining Node Types](#defining-node-types)
  - [Schema Features](#schema-features)
  - [Node Operations](#node-operations)
- [Edges](#edges) — Relationships between nodes
  - [Defining Edge Types](#defining-edge-types) (domain/range constraints)
  - [Edge Constraints](#edge-constraints) (cardinality)
  - [Edge Operations](#edge-operations)
- [Graph Definition](#graph-definition) — Combining nodes, edges, and ontology
- [Delete Behaviors](#delete-behaviors) — Restrict, cascade, disconnect
- [Uniqueness Constraints](#uniqueness-constraints) — Enforcing unique values
- [Type Inference](#type-inference) — Extracting TypeScript types from schemas

## Nodes

Nodes represent entities in your graph. Each node has:

- **Type**: The type of node (e.g., "Person", "Company")
- **ID**: A unique identifier within the graph
- **Props**: Properties defined by a Zod schema
- **Metadata**: Version, timestamps, and soft-delete state

### Defining Node Types

```typescript
import { z } from "zod";
import { defineNode } from "@nicia-ai/typegraph";

const Person = defineNode("Person", {
  schema: z.object({
    fullName: z.string().min(1),
    email: z.string().email().optional(),
    dateOfBirth: z.string().optional(),
    tags: z.array(z.string()).default([]),
  }),
  description: "A person in the system", // Optional
});
```

### Schema Features

TypeGraph supports all Zod validation features:

```typescript
const Product = defineNode("Product", {
  schema: z.object({
    // Required string
    name: z.string().min(1).max(200),

    // Optional with default
    status: z.enum(["draft", "active", "archived"]).default("draft"),

    // Number with constraints
    price: z.number().positive(),

    // Array with items validation
    categories: z.array(z.string()).min(1),

    // Regex pattern
    sku: z.string().regex(/^[A-Z]{2,4}-\d{4,8}$/),

    // Nullable field
    description: z.string().nullable(),

    // Transform on validation
    slug: z.string().transform((s) => s.toLowerCase().replace(/\s+/g, "-")),
  }),
});
```

### Node Operations

```typescript
// Create with auto-generated ID
const node = await store.nodes.Person.create({ fullName: "Alice Smith" });

// Create with specific ID
const node = await store.nodes.Person.create({ fullName: "Alice Smith" }, { id: "person-alice" });

// Retrieve
const person = await store.nodes.Person.getById("person-alice");

// Update (partial)
const updated = await store.nodes.Person.update("person-alice", {
  email: "alice@example.com",
});

// Delete (soft delete by default)
await store.nodes.Person.delete("person-alice");

// Hard delete (permanent removal) - use carefully!
await store.nodes.Person.hardDelete("person-alice");
```

### Node Object Shape

A node returned from the store has this structure:

```typescript
const alice = await store.nodes.Person.create({ name: "Alice", email: "a@example.com" });

// alice = {
//   id: "01HX...",          // Generated ULID (or your custom ID)
//   kind: "Person",         // The node type name
//   name: "Alice",          // Schema property (flattened to top level)
//   email: "a@example.com", // Schema property
//   meta: {
//     version: 1,
//     createdAt: "2024-01-15T10:30:00.000Z",
//     updatedAt: "2024-01-15T10:30:00.000Z",
//     deletedAt: undefined,
//     validFrom: undefined,
//     validTo: undefined,
//   }
// }
```

Schema properties are flattened to the top level for ergonomic access (`alice.name` instead of
`alice.props.name`). System metadata lives under `meta`.

### Soft Delete vs Hard Delete

By default, `delete()` performs a **soft delete**—it sets the `deletedAt` timestamp but preserves the record:

```typescript
await store.nodes.Person.delete(alice.id); // Sets deletedAt, keeps the record
```

For permanent removal, use `hardDelete()`:

```typescript
await store.nodes.Person.hardDelete(alice.id); // Removes from database
```

**When to use each:**

| Method | Use Case |
|--------|----------|
| `delete()` | Standard deletions, audit trails, undo capability |
| `hardDelete()` | GDPR erasure, storage cleanup, removing test data |

**Warning:** `hardDelete()` is irreversible. It also removes associated uniqueness entries and
embeddings. Consider using soft delete for most use cases.

## Edges

Edges represent relationships between nodes. Each edge has:

- **Type**: The type of relationship (e.g., "worksAt", "knows")
- **ID**: A unique identifier
- **From**: Source node (type + ID)
- **To**: Target node (type + ID)
- **Props**: Properties defined by a Zod schema

### Defining Edge Types

```typescript
import { defineEdge } from "@nicia-ai/typegraph";

// Edge with properties
const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
    isPrimary: z.boolean().default(true),
  }),
});

// Edge without properties
const knows = defineEdge("knows");
// Equivalent to: defineEdge("knows", { schema: z.object({}) })
```

#### Domain and Range Constraints

Edges can include built-in domain (source types) and range (target types) constraints
directly in their definition. This makes edge definitions self-contained and reusable:

```typescript
// Edge with built-in domain/range constraints
const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
  }),
  from: [Person],      // Domain: only Person can be the source
  to: [Company],       // Range: only Company can be the target
});

// Edge connecting multiple types
const mentions = defineEdge("mentions", {
  from: [Article, Comment],
  to: [Person, Company, Topic],
});
```

When an edge has `from` and `to` defined, you can use it directly in `defineGraph` without an `EdgeRegistration` wrapper:

```typescript
const graph = defineGraph({
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    worksAt,  // Direct use - constraints come from the edge definition
  },
});
```

You can still use `EdgeRegistration` to narrow (but not widen) the constraints:

```typescript
const worksAt = defineEdge("worksAt", {
  from: [Person],
  to: [Company, Subsidiary],  // Allows both Company and Subsidiary
});

const graph = defineGraph({
  edges: {
    // Narrow to only Subsidiary targets in this graph
    worksAt: { type: worksAt, from: [Person], to: [Subsidiary] },
  },
});
```

Attempting to widen beyond the edge's built-in constraints throws a `ValidationError`:

```typescript
const worksAt = defineEdge("worksAt", {
  from: [Person],
  to: [Company],
});

// This throws ValidationError - OtherEntity is not in the edge's range
defineGraph({
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [OtherEntity] },
  },
});
```

### Edge Constraints

#### Cardinality

Control how many edges can exist:

```typescript
const graph = defineGraph({
  edges: {
    // Default: no limit
    knows: { type: knows, from: [Person], to: [Person], cardinality: "many" },

    // At most one edge of this type from any source node
    currentEmployer: {
      type: currentEmployer,
      from: [Person],
      to: [Company],
      cardinality: "one",
    },

    // At most one edge between any (source, target) pair
    rated: { type: rated, from: [Person], to: [Product], cardinality: "unique" },

    // At most one active edge (valid_to IS NULL) from any source
    currentRole: {
      type: currentRole,
      from: [Person],
      to: [Company],
      cardinality: "oneActive",
    },
  },
});
```

| Cardinality | Description |
|-------------|-------------|
| `"many"` | No limit (default) |
| `"one"` | At most one edge of this type from any source node |
| `"unique"` | At most one edge between any (source, target) pair |
| `"oneActive"` | At most one edge with `valid_to IS NULL` from any source |

#### Enforcement Timing

Cardinality constraints are checked at edge **creation time**, before the insert:

```typescript
// With cardinality: "one" on currentEmployer:
await store.edges.currentEmployer.create(alice, acme, {});  // OK
await store.edges.currentEmployer.create(alice, other, {}); // Throws CardinalityError
```

The check queries existing edges and throws `CardinalityError` if violated.
For `oneActive`, only edges with `validTo` unset count toward the limit.

### Edge Operations

```typescript
// Create edge - pass nodes directly
const edge = await store.edges.worksAt.create(alice, acme, { role: "Engineer" });

// Retrieve edge
const e = await store.edges.worksAt.getById(edge.id);

// Delete edge
await store.edges.worksAt.delete(edge.id);
```

## Graph Definition

The graph definition combines all components:

```typescript
import { defineGraph } from "@nicia-ai/typegraph";

const graph = defineGraph({
  // Unique identifier for this graph
  id: "my_application",

  // Node registrations
  nodes: {
    Person: {
      type: Person,
      onDelete: "restrict", // Default behavior
    },
    Company: {
      type: Company,
      onDelete: "cascade",
    },
    Employment: {
      type: Employment,
      onDelete: "disconnect",
    },
  },

  // Edge registrations
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
    employedAt: {
      type: employedAt,
      from: [Company],
      to: [Employment],
      cardinality: "many",
    },
  },

  // Semantic relationships
  ontology: [subClassOf(Company, Organization), disjointWith(Person, Company)],
});
```

## Delete Behaviors

Control what happens when nodes are deleted:

### Restrict (Default)

Blocks deletion if any edges are connected:

```typescript
nodes: {
  Author: { type: Author }, // onDelete defaults to "restrict"
}

// This throws RestrictedDeleteError if Author has edges
await store.nodes.Author.delete(authorId);
```

### Cascade

Automatically deletes all connected edges:

```typescript
nodes: {
  Book: { type: Book, onDelete: "cascade" },
}

// Deletes the book and all edges connected to it
await store.nodes.Book.delete(bookId);
```

### Disconnect

Soft-deletes edges (preserves history):

```typescript
nodes: {
  Review: { type: Review, onDelete: "disconnect" },
}

// Marks connected edges as deleted (deleted_at is set)
await store.nodes.Review.delete(reviewId);
```

## Uniqueness Constraints

Ensure unique values within node types:

```typescript
const graph = defineGraph({
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          where: (props) => props.email.isNotNull(),
          scope: "kind",
          collation: "caseInsensitive",
        },
      ],
    },
    Company: {
      type: Company,
      unique: [
        {
          name: "company_ticker",
          fields: ["ticker"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
});
```

### Scope Options

- `"kind"`: Unique within this exact type only
- `"kindWithSubClasses"`: Unique across this type and all subclasses

### Collation Options

- `"binary"`: Case-sensitive comparison
- `"caseInsensitive"`: Case-insensitive comparison

## Type Inference

TypeGraph infers TypeScript types from Zod schemas—you never duplicate type definitions.

### Extracting Types from Definitions

```typescript
import { z } from "zod";
import { defineNode, type Node, type NodeProps, type NodeId } from "@nicia-ai/typegraph";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().email().optional(),
    age: z.number().optional(),
  }),
});

// For functions that work with full nodes (id, kind, metadata, props):
type PersonNode = Node<typeof Person>;
// { id: NodeId<Person>; kind: "Person"; name: string; email?: string; version: number; createdAt: Date; ... }

// For functions that only need the property data:
type PersonProps = NodeProps<typeof Person>;
// { name: string; email?: string; age?: number }

// For type-safe node IDs (prevents mixing IDs from different node types):
type PersonId = NodeId<typeof Person>;
// string & { readonly [__nodeId]: typeof Person }
```

Use `Node<typeof X>` when your function needs the full node with metadata.
 Use `NodeProps<typeof X>` when you only care about the schema properties (e.g., for form validation or API payloads).

### Typed Store Operations

```typescript
// Create returns a fully typed Node
const alice: Node<typeof Person> = await store.nodes.Person.create({
  name: "Alice",
  email: "alice@example.com",
});

// TypeScript knows the structure
alice.id;              // NodeId<typeof Person> - branded string
alice.name;            // string
alice.email;           // string | undefined
alice.age;             // number | undefined
alice.version;         // number
alice.createdAt;       // Date

// Type errors caught at compile time
await store.nodes.Person.create({
  name: 123,           // Error: Type 'number' is not assignable to type 'string'
  invalid: "field",    // Error: Object literal may only specify known properties
});
```

### Typed Query Results

```typescript
// Result type is inferred from your select projection
const results = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ({
    name: ctx.p.name,     // TypeScript knows: string
    email: ctx.p.email,   // TypeScript knows: string | undefined
    id: ctx.p.id,         // TypeScript knows: NodeId<Person>
  }))
  .execute();

// results: Array<{ name: string; email: string | undefined; id: NodeId<Person> }>

// Invalid property access is caught
.select((ctx) => ({
  invalid: ctx.p.nonexistent,  // TypeScript error!
}))
```

### Typed Edge Operations

Edge endpoints are constrained to valid node types:

```typescript
// Edge definition: worksAt goes from Person → Company
const graph = defineGraph({
  // ...
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
  },
});

// TypeScript enforces valid endpoints
await store.edges.worksAt.create(alice, acmeCorp, { role: "Engineer" }); // OK

await store.edges.worksAt.create(acmeCorp, alice, { role: "Engineer" });
// Error: Argument of type 'Node<Company>' is not assignable to parameter of type 'Node<Person>'
```
