---
title: Multi-Tenant SaaS
description: Complete multi-tenancy patterns with isolation, data partitioning, and tenant management
---

This example shows how to build a multi-tenant SaaS application with:

- **Three isolation strategies** (shared tables, schema per tenant, database per tenant)
- **Tenant-aware queries** that automatically filter data
- **Tenant provisioning** and lifecycle management
- **Cross-tenant analytics** for platform operators
- **Tenant migration** between isolation levels

## Choosing an Isolation Strategy

| Strategy | Isolation | Complexity | Cost | Best For |
|----------|-----------|------------|------|----------|
| Shared tables | Low | Low | Lowest | Many small tenants, B2C SaaS |
| Schema per tenant | Medium | Medium | Low | SMB customers, PostgreSQL only |
| Database per tenant | High | High | Highest | Enterprise, compliance requirements |

## Strategy 1: Shared Tables with Row-Level Isolation

All tenants share the same database tables, filtered by `tenantId`.

### Schema Definition

```typescript
import { z } from "zod";
import { defineNode, defineEdge, defineGraph } from "@nicia-ai/typegraph";

// Tenant metadata
const Tenant = defineNode("Tenant", {
  schema: z.object({
    slug: z.string(),
    name: z.string(),
    plan: z.enum(["free", "starter", "pro", "enterprise"]),
    status: z.enum(["active", "suspended", "cancelled"]).default("active"),
    createdAt: z.string().datetime(),
    settings: z.record(z.unknown()).optional(),
  }),
});

// All entities include tenantId
const Project = defineNode("Project", {
  schema: z.object({
    tenantId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    status: z.enum(["active", "archived"]).default("active"),
  }),
});

const Task = defineNode("Task", {
  schema: z.object({
    tenantId: z.string(),
    title: z.string(),
    status: z.enum(["todo", "in_progress", "done"]).default("todo"),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
  }),
});

const User = defineNode("User", {
  schema: z.object({
    tenantId: z.string(),
    email: z.string().email(),
    name: z.string(),
    role: z.enum(["owner", "admin", "member", "guest"]).default("member"),
  }),
});

// Edges
const hasProject = defineEdge("hasProject");
const hasTask = defineEdge("hasTask");
const assignedTo = defineEdge("assignedTo");
const memberOf = defineEdge("memberOf");

const graph = defineGraph({
  id: "multi_tenant",
  nodes: {
    Tenant: { type: Tenant },
    Project: { type: Project },
    Task: { type: Task },
    User: { type: User },
  },
  edges: {
    hasProject: { type: hasProject, from: [Tenant], to: [Project] },
    hasTask: { type: hasTask, from: [Project], to: [Task] },
    assignedTo: { type: assignedTo, from: [Task], to: [User] },
    memberOf: { type: memberOf, from: [User], to: [Tenant] },
  },
});
```

### Tenant-Scoped Store

Create a wrapper that automatically filters by tenant:

```typescript
interface TenantContext {
  tenantId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "guest";
}

function createTenantStore(store: Store, ctx: TenantContext) {
  const projects = {
    async list(options: { status?: string } = {}) {
      let query = store
        .query()
        .from("Project", "p")
        .whereNode("p", (p) => p.tenantId.eq(ctx.tenantId));

      if (options.status) {
        query = query.whereNode("p", (p) => p.status.eq(options.status));
      }

      return query.select((q) => q.p).execute();
    },

    async create(data: { name: string; description?: string }) {
      const project = await store.nodes.Project.create({
        ...data,
        tenantId: ctx.tenantId,
      });

      const tenant = await store.nodes.Tenant.getById(ctx.tenantId);
      if (!tenant) throw new Error(`Tenant not found: ${ctx.tenantId}`);
      await store.edges.hasProject.create(tenant, project, {});

      return project;
    },

    async get(projectId: string) {
      const project = await store.nodes.Project.getById(projectId);
      if (!project || project.tenantId !== ctx.tenantId) {
        throw new Error("Not found");
      }
      return project;
    },

    async update(projectId: string, updates: Partial<ProjectProps>) {
      await projects.get(projectId); // Verify access
      return store.nodes.Project.update(projectId, updates);
    },

    async delete(projectId: string) {
      await projects.get(projectId); // Verify access
      await store.nodes.Project.delete(projectId);
    },
  };

  const tasks = {
    async list(projectId: string) {
      await projects.get(projectId); // Verify access

      return store
        .query()
        .from("Project", "p")
        .whereNode("p", (p) => p.id.eq(projectId))
        .traverse("hasTask", "e")
        .to("Task", "t")
        .select((q) => q.t)
        .execute();
    },

    async create(projectId: string, data: { title: string; priority?: string }) {
      const project = await projects.get(projectId); // Verify access

      const task = await store.nodes.Task.create({
        ...data,
        tenantId: ctx.tenantId,
      });

      await store.edges.hasTask.create(project, task, {});
      return task;
    },
  };

  const users = {
    async list() {
      return store
        .query()
        .from("User", "u")
        .whereNode("u", (u) => u.tenantId.eq(ctx.tenantId))
        .select((q) => q.u)
        .execute();
    },

    async invite(email: string, name: string, role: string) {
      if (ctx.role !== "owner" && ctx.role !== "admin") {
        throw new Error("Insufficient permissions");
      }

      const user = await store.nodes.User.create({
        tenantId: ctx.tenantId,
        email,
        name,
        role,
      });

      const tenant = await store.nodes.Tenant.getById(ctx.tenantId);
      if (!tenant) throw new Error(`Tenant not found: ${ctx.tenantId}`);
      await store.edges.memberOf.create(user, tenant, {});

      return user;
    },
  };

  return { projects, tasks, users };
}

// Usage in API handler
async function handleRequest(req: Request) {
  const session = await getSession(req);
  const tenantStore = createTenantStore(store, {
    tenantId: session.tenantId,
    userId: session.userId,
    role: session.role,
  });

  // All queries are automatically tenant-scoped
  const projects = await tenantStore.projects.list();
}
```

### Tenant Provisioning

```typescript
async function provisionTenant(
  slug: string,
  name: string,
  ownerEmail: string,
  ownerName: string,
  plan: "free" | "starter" | "pro" | "enterprise" = "free"
): Promise<{ tenant: Node<typeof Tenant>; owner: Node<typeof User> }> {
  return store.transaction(async (tx) => {
    // Check slug uniqueness
    const existing = await tx
      .query()
      .from("Tenant", "t")
      .whereNode("t", (t) => t.slug.eq(slug))
      .first();

    if (existing) {
      throw new Error("Tenant slug already exists");
    }

    // Create tenant
    const tenant = await tx.nodes.Tenant.create({
      slug,
      name,
      plan,
      status: "active",
      createdAt: new Date().toISOString(),
    });

    // Create owner user
    const owner = await tx.nodes.User.create({
      tenantId: tenant.id,
      email: ownerEmail,
      name: ownerName,
      role: "owner",
    });

    await tx.edges.memberOf.create(owner, tenant, {});

    return { tenant, owner };
  });
}
```

## Strategy 2: Schema Per Tenant (PostgreSQL)

Each tenant gets their own PostgreSQL schema within the same database.

### Setup

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createPostgresBackend, generatePostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function createTenantSchema(tenantId: string): Promise<void> {
  const schemaName = `tenant_${tenantId}`;

  // Create schema
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

  // Run TypeGraph migrations in the tenant schema
  await pool.query(`SET search_path TO ${schemaName}`);
  await pool.query(generatePostgresMigrationSQL());
  await pool.query(`SET search_path TO public`);
}

async function getTenantStore(tenantId: string): Promise<Store> {
  const schemaName = `tenant_${tenantId}`;

  // Create connection with schema
  const client = await pool.connect();
  await client.query(`SET search_path TO ${schemaName}`);

  const db = drizzle(client);
  const backend = createPostgresBackend(db);

  return createStore(graph, backend);
}
```

### Tenant Store Cache

```typescript
class TenantStoreManager {
  private stores = new Map<string, { store: Store; lastUsed: Date }>();
  private maxCached = 100;

  async getStore(tenantId: string): Promise<Store> {
    const cached = this.stores.get(tenantId);

    if (cached) {
      cached.lastUsed = new Date();
      return cached.store;
    }

    // Evict oldest if at capacity
    if (this.stores.size >= this.maxCached) {
      this.evictOldest();
    }

    const store = await getTenantStore(tenantId);
    this.stores.set(tenantId, { store, lastUsed: new Date() });

    return store;
  }

  private evictOldest(): void {
    let oldest: { id: string; date: Date } | undefined;

    for (const [id, { lastUsed }] of this.stores) {
      if (!oldest || lastUsed < oldest.date) {
        oldest = { id, date: lastUsed };
      }
    }

    if (oldest) {
      this.stores.delete(oldest.id);
    }
  }
}

const tenantManager = new TenantStoreManager();
```

### Provisioning with Schema

```typescript
async function provisionTenantWithSchema(
  slug: string,
  name: string,
  ownerEmail: string
): Promise<{ tenantId: string }> {
  const tenantId = generateUUID();

  // Create schema and tables
  await createTenantSchema(tenantId);

  // Get tenant-specific store
  const tenantStore = await tenantManager.getStore(tenantId);

  // Create initial data
  await tenantStore.nodes.User.create({
    email: ownerEmail,
    name: name,
    role: "owner",
  });

  // Store tenant metadata in public schema
  const publicDb = drizzle(pool);
  await publicDb.insert(tenants).values({
    id: tenantId,
    slug,
    name,
    createdAt: new Date(),
  });

  return { tenantId };
}
```

## Strategy 3: Database Per Tenant

Each tenant gets their own database for maximum isolation.

### Tenant Database Manager

```typescript
interface TenantConfig {
  id: string;
  slug: string;
  databaseUrl: string;
  status: "active" | "suspended";
}

class TenantDatabaseManager {
  private connections = new Map<string, { pool: Pool; store: Store }>();
  private maxConnections = 50;

  async getStore(tenantId: string): Promise<Store> {
    const cached = this.connections.get(tenantId);
    if (cached) return cached.store;

    // Get tenant config from central registry
    const config = await this.getTenantConfig(tenantId);

    if (config.status !== "active") {
      throw new Error("Tenant is not active");
    }

    // Evict if at capacity
    if (this.connections.size >= this.maxConnections) {
      await this.evictLeastUsed();
    }

    // Create new connection
    const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
    const db = drizzle(pool);
    const backend = createPostgresBackend(db);
    const store = createStore(graph, backend);

    this.connections.set(tenantId, { pool, store });

    return store;
  }

  async closeConnection(tenantId: string): Promise<void> {
    const conn = this.connections.get(tenantId);
    if (conn) {
      await conn.pool.end();
      this.connections.delete(tenantId);
    }
  }

  private async getTenantConfig(tenantId: string): Promise<TenantConfig> {
    // Fetch from central tenant registry
    const result = await centralDb
      .select()
      .from(tenantConfigs)
      .where(eq(tenantConfigs.id, tenantId))
      .get();

    if (!result) throw new Error("Tenant not found");

    return result;
  }

  private async evictLeastUsed(): Promise<void> {
    // Simple LRU eviction
    const first = this.connections.keys().next().value;
    if (first) {
      await this.closeConnection(first);
    }
  }
}

const dbManager = new TenantDatabaseManager();
```

### Provisioning New Database

```typescript
async function provisionTenantDatabase(
  slug: string,
  name: string,
  ownerEmail: string
): Promise<{ tenantId: string; databaseUrl: string }> {
  const tenantId = generateUUID();
  const dbName = `tenant_${tenantId.replace(/-/g, "_")}`;

  // Create database (using admin connection)
  const adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  await adminPool.end();

  // Build connection URL
  const baseUrl = new URL(process.env.DATABASE_BASE_URL!);
  baseUrl.pathname = `/${dbName}`;
  const databaseUrl = baseUrl.toString();

  // Initialize TypeGraph tables
  const tenantPool = new Pool({ connectionString: databaseUrl });
  await tenantPool.query(generatePostgresMigrationSQL());

  // Create initial data
  const db = drizzle(tenantPool);
  const backend = createPostgresBackend(db);
  const store = createStore(graph, backend);

  await store.nodes.User.create({
    email: ownerEmail,
    name: name,
    role: "owner",
  });

  await tenantPool.end();

  // Register in central tenant registry
  await centralDb.insert(tenantConfigs).values({
    id: tenantId,
    slug,
    name,
    databaseUrl,
    status: "active",
    createdAt: new Date(),
  });

  return { tenantId, databaseUrl };
}
```

## Cross-Tenant Operations

For platform administrators who need to query across tenants.

### Aggregated Metrics (Shared Tables)

```typescript
import { count, field } from "@nicia-ai/typegraph";

async function getTenantMetrics(): Promise<
  Array<{ tenantId: string; projectCount: number; taskCount: number; userCount: number }>
> {
  // Projects by tenant
  const projectCounts = await store
    .query()
    .from("Project", "p")
    .groupBy("p", "tenantId")
    .aggregate({
      tenantId: field("p", "tenantId"),
      projectCount: count("p"),
    })
    .execute();

  // Tasks by tenant
  const taskCounts = await store
    .query()
    .from("Task", "t")
    .groupBy("t", "tenantId")
    .aggregate({
      tenantId: field("t", "tenantId"),
      taskCount: count("t"),
    })
    .execute();

  // Users by tenant
  const userCounts = await store
    .query()
    .from("User", "u")
    .groupBy("u", "tenantId")
    .aggregate({
      tenantId: field("u", "tenantId"),
      userCount: count("u"),
    })
    .execute();

  // Merge results
  const metrics = new Map<string, { projectCount: number; taskCount: number; userCount: number }>();

  for (const p of projectCounts) {
    metrics.set(p.tenantId, { projectCount: p.projectCount, taskCount: 0, userCount: 0 });
  }

  for (const t of taskCounts) {
    const existing = metrics.get(t.tenantId) || { projectCount: 0, taskCount: 0, userCount: 0 };
    existing.taskCount = t.taskCount;
    metrics.set(t.tenantId, existing);
  }

  for (const u of userCounts) {
    const existing = metrics.get(u.tenantId) || { projectCount: 0, taskCount: 0, userCount: 0 };
    existing.userCount = u.userCount;
    metrics.set(u.tenantId, existing);
  }

  return Array.from(metrics.entries()).map(([tenantId, counts]) => ({
    tenantId,
    ...counts,
  }));
}
```

### Cross-Tenant Search (Database Per Tenant)

```typescript
async function searchAcrossTenants(
  query: string,
  tenantIds: string[]
): Promise<Array<{ tenantId: string; results: ProjectProps[] }>> {
  const results = await Promise.all(
    tenantIds.map(async (tenantId) => {
      try {
        const store = await dbManager.getStore(tenantId);

        const projects = await store
          .query()
          .from("Project", "p")
          .whereNode("p", (p) => p.name.contains(query))
          .select((ctx) => ctx.p)
          .limit(10)
          .execute();

        return { tenantId, results: projects };
      } catch (error) {
        console.error(`Failed to search tenant ${tenantId}:`, error);
        return { tenantId, results: [] };
      }
    })
  );

  return results;
}
```

## Tenant Lifecycle

### Suspend Tenant

```typescript
async function suspendTenant(tenantId: string, reason: string): Promise<void> {
  const current = await store.nodes.Tenant.getById(tenantId);
  if (!current) throw new Error(`Tenant not found: ${tenantId}`);

  await store.nodes.Tenant.update(tenantId, {
    status: "suspended",
    settings: {
      ...(current.settings || {}),
      suspendedAt: new Date().toISOString(),
      suspendReason: reason,
    },
  });
}
```

### Delete Tenant (Shared Tables)

```typescript
async function deleteTenant(tenantId: string): Promise<void> {
  await store.transaction(async (tx) => {
    // Delete all tasks
    const tasks = await tx
      .query()
      .from("Task", "t")
      .whereNode("t", (t) => t.tenantId.eq(tenantId))
      .select((ctx) => ctx.t.id)
      .execute();

    for (const taskId of tasks) {
      await tx.nodes.Task.delete(taskId);
    }

    // Delete all projects
    const projects = await tx
      .query()
      .from("Project", "p")
      .whereNode("p", (p) => p.tenantId.eq(tenantId))
      .select((ctx) => ctx.p.id)
      .execute();

    for (const projectId of projects) {
      await tx.nodes.Project.delete(projectId);
    }

    // Delete all users
    const users = await tx
      .query()
      .from("User", "u")
      .whereNode("u", (u) => u.tenantId.eq(tenantId))
      .select((ctx) => ctx.u.id)
      .execute();

    for (const userId of users) {
      await tx.nodes.User.delete(userId);
    }

    // Delete tenant
    await tx.nodes.Tenant.delete(tenantId);
  });
}
```

### Delete Tenant (Database Per Tenant)

```typescript
async function deleteTenantDatabase(tenantId: string): Promise<void> {
  // Close active connection
  await dbManager.closeConnection(tenantId);

  // Get database name
  const config = await getTenantConfig(tenantId);
  const dbUrl = new URL(config.databaseUrl);
  const dbName = dbUrl.pathname.slice(1);

  // Drop database
  const adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await adminPool.end();

  // Remove from registry
  await centralDb.delete(tenantConfigs).where(eq(tenantConfigs.id, tenantId));
}
```

## Tenant Migration

Move tenant between isolation strategies:

```typescript
async function migrateTenantToSeparateDatabase(tenantId: string): Promise<string> {
  // 1. Create new database
  const { databaseUrl } = await provisionTenantDatabase(
    `migrated_${tenantId}`,
    "Migrated Tenant",
    "placeholder@example.com"
  );

  // 2. Get tenant data from shared tables
  const sharedStore = store;

  const projects = await sharedStore
    .query()
    .from("Project", "p")
    .whereNode("p", (p) => p.tenantId.eq(tenantId))
    .select((ctx) => ctx.p)
    .execute();

  const tasks = await sharedStore
    .query()
    .from("Task", "t")
    .whereNode("t", (t) => t.tenantId.eq(tenantId))
    .select((ctx) => ctx.t)
    .execute();

  const users = await sharedStore
    .query()
    .from("User", "u")
    .whereNode("u", (u) => u.tenantId.eq(tenantId))
    .select((ctx) => ctx.u)
    .execute();

  // 3. Insert into new database
  const newStore = await dbManager.getStore(tenantId);

  await newStore.transaction(async (tx) => {
    for (const project of projects) {
      await tx.nodes.Project.create(project);
    }

    for (const task of tasks) {
      await tx.nodes.Task.create(task);
    }

    for (const user of users) {
      await tx.nodes.User.create(user);
    }
  });

  // 4. Delete from shared tables
  await deleteTenant(tenantId);

  return databaseUrl;
}
```

## Next Steps

- [Document Management](/examples/document-management) - CMS with semantic search
- [Product Catalog](/examples/product-catalog) - Categories, variants, inventory
- [Integration Patterns](/integration) - More deployment strategies
