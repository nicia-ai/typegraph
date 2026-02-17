---
title: Quick Start
description: Set up TypeGraph and build your first knowledge graph
---

Get TypeGraph running in your project with this minimal example.

## 1. Install

```bash
npm install @nicia-ai/typegraph zod drizzle-orm better-sqlite3
npm install -D @types/better-sqlite3
```

> **Edge environments (Cloudflare Workers, etc.):** Skip `better-sqlite3` and use
> `@nicia-ai/typegraph/drizzle/sqlite` with your edge-compatible driver (D1, libsql).
> See [Edge and Serverless](/integration#edge-and-serverless).

## 2. Create Your First Graph

```typescript
import { z } from "zod";
import { defineNode, defineEdge, defineGraph, createStore } from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite";

// Create an in-memory SQLite backend
const { backend } = createLocalSqliteBackend();

// Define your schema
const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), role: z.string().optional() }),
});
const Project = defineNode("Project", {
  schema: z.object({ name: z.string(), status: z.enum(["active", "done"]) }),
});
const worksOn = defineEdge("worksOn");

const graph = defineGraph({
  id: "my_app",
  nodes: { Person: { type: Person }, Project: { type: Project } },
  edges: { worksOn: { type: worksOn, from: [Person], to: [Project] } },
});

// Create the store
const store = createStore(graph, backend);

// Use it!
const alice = await store.nodes.Person.create({ name: "Alice", role: "Engineer" });
const project = await store.nodes.Project.create({ name: "Website", status: "active" });
await store.edges.worksOn.create(alice, project, {});

// Query with full type safety
const results = await store
  .query()
  .from("Person", "p")
  .traverse("worksOn", "e")
  .to("Project", "proj")
  .select((ctx) => ({ person: ctx.p.name, project: ctx.proj.name }))
  .execute();

console.log(results); // [{ person: "Alice", project: "Website" }]
```

That's it! You have a working knowledge graph. Read on for the complete setup guide.

---

## Complete Setup Guide

This section covers production setup with SQLite and PostgreSQL in detail.

### Installation

```bash
npm install @nicia-ai/typegraph zod drizzle-orm better-sqlite3
npm install -D @types/better-sqlite3
```

> `better-sqlite3` is optional. For edge environments, use `@nicia-ai/typegraph/drizzle/sqlite`
> with D1, libsql, or bun:sqlite instead.

### SQLite Setup

TypeGraph provides two ways to set up SQLite:

#### Quick Setup (Recommended for Development)

The simplest way to get started. Handles database creation and schema setup automatically.

> **Note:** `createLocalSqliteBackend` requires `better-sqlite3` and only works in Node.js.
> For edge environments, see [Manual Setup](#manual-setup-full-control) with `/drizzle/sqlite`.

```typescript
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite";

// In-memory database (data lost on restart)
const { backend } = createLocalSqliteBackend();

// File-based database (persistent)
const { backend, db } = createLocalSqliteBackend({ path: "./my-app.db" });
```

The function returns both the `backend` (for use with `createStore`) and `db`
(the underlying Drizzle instance for direct SQL access if needed).

#### Manual Setup (Full Control)

For production deployments or when you need full control over the database configuration:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteBackend, getSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";

// Create database connection
const sqlite = new Database("my-app.db");

// Run TypeGraph migrations (creates required tables)
sqlite.exec(getSqliteMigrationSQL());

// Create Drizzle instance
const db = drizzle(sqlite);

// Create the backend
const backend = createSqliteBackend(db);
```

#### Edge-Compatible Setup (D1, libsql, bun:sqlite)

For Cloudflare Workers, Turso, or other edge environments, use the driver-agnostic backend:

```typescript
import { drizzle } from "drizzle-orm/d1"; // or libsql, bun-sqlite
import { createSqliteBackend } from "@nicia-ai/typegraph/drizzle/sqlite";

// D1 example
const db = drizzle(env.DB);
const backend = createSqliteBackend(db);
```

Use [drizzle-kit managed migrations](/integration#drizzle-kit-managed-migrations-recommended)
to set up the schema.

#### Drizzle-Kit Managed Migrations

If you already use `drizzle-kit` for migrations, see [Drizzle-Kit Managed Migrations](/integration#drizzle-kit-managed-migrations-recommended)
for how to import TypeGraph's schema into your `schema.ts` file.

## Defining Your Schema

### Step 1: Define Node Types

Nodes represent entities in your graph. Each node type has a name and a Zod schema:

```typescript
import { z } from "zod";
import { defineNode } from "@nicia-ai/typegraph";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    bio: z.string().optional(),
  }),
});

const Project = defineNode("Project", {
  schema: z.object({
    name: z.string(),
    description: z.string().optional(),
    status: z.enum(["planning", "active", "completed"]),
  }),
});

const Task = defineNode("Task", {
  schema: z.object({
    title: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    completed: z.boolean().default(false),
  }),
});
```

### Step 2: Define Edge Types

Edges represent relationships between nodes:

```typescript
import { defineEdge } from "@nicia-ai/typegraph";

const worksOn = defineEdge("worksOn", {
  schema: z.object({
    role: z.string().optional(),
    since: z.string().optional(),
  }),
});

const hasTask = defineEdge("hasTask", {
  schema: z.object({}),
});

const assignedTo = defineEdge("assignedTo", {
  schema: z.object({
    assignedAt: z.string().optional(),
  }),
});
```

### Step 3: Create the Graph Definition

Combine nodes, edges, and ontology into a graph:

```typescript
import { defineGraph, disjointWith } from "@nicia-ai/typegraph";

const graph = defineGraph({
  id: "project_management",
  nodes: {
    Person: { type: Person },
    Project: { type: Project },
    Task: { type: Task },
  },
  edges: {
    worksOn: { type: worksOn, from: [Person], to: [Project] },
    hasTask: { type: hasTask, from: [Project], to: [Task] },
    assignedTo: { type: assignedTo, from: [Task], to: [Person] },
  },
  ontology: [
    // A Person cannot be a Project or Task
    disjointWith(Person, Project),
    disjointWith(Person, Task),
    disjointWith(Project, Task),
  ],
});
```

### Step 4: Create the Store

The store connects your graph definition to the database:

```typescript
import { createStore } from "@nicia-ai/typegraph";

const store = createStore(graph, backend);
```

#### Store Creation: Which Function to Use

| Function | Schema Handling | Use Case |
|----------|-----------------|----------|
| `createLocalSqliteBackend` | Automatic | Quick start, development, tests |
| `createStore` + manual migration | None | When you manage migrations externally |
| `createStoreWithSchema` | Validates & auto-migrates | **Recommended for production** |

For production, use `createStoreWithSchema` to validate and auto-apply safe schema changes:

```typescript
import { createStoreWithSchema } from "@nicia-ai/typegraph";

const [store, result] = await createStoreWithSchema(graph, backend);

if (result.status === "initialized") {
  console.log("Schema initialized at version", result.version);
} else if (result.status === "migrated") {
  console.log(`Migrated from v${result.fromVersion} to v${result.toVersion}`);
}
// Other statuses: "unchanged", "pending", "breaking"
// See Schema Migrations for full details
```

#### Graph ID

Every graph has a unique `id` that scopes its data:

```typescript
const graph = defineGraph({
  id: "my_app",  // Scopes all nodes/edges to this graph
  // ...
});
```

**Key behaviors:**

- All nodes and edges are stored with this `graph_id` in the database
- Multiple graphs can share the same database tables (isolated by `graph_id`)
- Changing the ID creates a new, empty graph (existing data is orphaned)

See [Multiple Graphs](/multiple-graphs) for multi-graph deployments.

## Working with Data

### Creating Nodes

```typescript
const alice = await store.nodes.Person.create({
  name: "Alice Smith",
  email: "alice@example.com",
});

const project = await store.nodes.Project.create({
  name: "Website Redesign",
  status: "active",
});

const task = await store.nodes.Task.create({
  title: "Design mockups",
  priority: "high",
});
```

### Creating Edges

Pass node objects directly to create edges:

```typescript
await store.edges.worksOn.create(alice, project, { role: "Lead Designer" });

await store.edges.hasTask.create(project, task, {});

await store.edges.assignedTo.create(task, alice, { assignedAt: new Date().toISOString() });
```

### Retrieving Nodes

```typescript
const person = await store.nodes.Person.getById(alice.id);
console.log(person?.name); // "Alice Smith"
```

### Updating Nodes

```typescript
const updated = await store.nodes.Task.update(task.id, { completed: true });
```

### Deleting Nodes

```typescript
await store.nodes.Task.delete(task.id);
```

## Querying Data

TypeGraph provides a fluent query builder:

```typescript
// Find all active projects
const activeProjects = await store
  .query()
  .from("Project", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .select((ctx) => ctx.p)
  .execute();

// Find people working on a project
const teamMembers = await store
  .query()
  .from("Project", "p")
  .traverse("worksOn", "e", { direction: "in" })
  .to("Person", "person")
  .select((ctx) => ({
    project: ctx.p.name,
    person: ctx.person.name,
  }))
  .execute();

// Multi-hop traversal: find tasks for a person
const myTasks = await store
  .query()
  .from("Person", "person")
  .whereNode("person", (p) => p.name.eq("Alice Smith"))
  .traverse("worksOn", "e1")
  .to("Project", "project")
  .traverse("hasTask", "e2")
  .to("Task", "task")
  .select((ctx) => ({
    project: ctx.project.name,
    task: ctx.task.title,
    priority: ctx.task.priority,
  }))
  .execute();
```

## Transactions

Group operations in transactions for atomicity:

```typescript
await store.transaction(async (tx) => {
  const project = await tx.nodes.Project.create({
    name: "New Feature",
    status: "planning",
  });

  const task1 = await tx.nodes.Task.create({
    title: "Research",
    priority: "high",
  });

  const task2 = await tx.nodes.Task.create({
    title: "Implementation",
    priority: "medium",
  });

  await tx.edges.hasTask.create(project, task1, {});

  await tx.edges.hasTask.create(project, task2, {});
});
```

## Error Handling

TypeGraph provides specific error types:

```typescript
import { ValidationError, NodeNotFoundError, DisjointError, RestrictedDeleteError } from "@nicia-ai/typegraph";

try {
  await store.nodes.Person.create({ name: "" }); // Invalid: empty name
} catch (error) {
  if (error instanceof ValidationError) {
    console.log("Validation failed:", error.message);
  }
}

try {
  await store.nodes.Project.delete(project.id);
} catch (error) {
  if (error instanceof RestrictedDeleteError) {
    console.log("Cannot delete: edges exist");
  }
}
```

## PostgreSQL Setup

TypeGraph also supports PostgreSQL for production deployments with better concurrency and JSON support.

### Installation

```bash
npm install @nicia-ai/typegraph zod drizzle-orm pg
npm install -D @types/pg
```

### Database Setup

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend, getPostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Connection pool size
});

// Run TypeGraph migrations
await pool.query(getPostgresMigrationSQL());

// Create Drizzle instance and backend
const db = drizzle(pool);
const backend = createPostgresBackend(db);
```

If you use `drizzle-kit` for migrations, see [Drizzle-Kit Managed Migrations](/integration#drizzle-kit-managed-migrations-recommended).

### PostgreSQL Advantages

- **JSONB**: Native JSON type with efficient indexing
- **Connection pooling**: Better concurrency handling
- **Partial indexes**: More efficient uniqueness constraints
- **Full transactions**: ACID guarantees across operations

### Using with Connection Pools

For production, always use connection pooling:

```typescript
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await pool.end();
});
```

## Next Steps

- [Project Structure](/project-structure) - Organize your graph definitions as your project grows
- [Schemas & Types](/core-concepts) - Deep dive into nodes, edges, and schemas
- [Ontology](/ontology) - Learn about semantic relationships
- [Query Builder](/queries/overview) - Query patterns and traversals
- [Schemas & Stores](/schemas-stores) - Complete API documentation
