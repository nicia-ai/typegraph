---
title: Integration Patterns
description: Strategies for integrating TypeGraph into your application architecture
---

This guide covers common integration patterns for adding TypeGraph to existing
applications, from simple setups to production deployment strategies.

## Direct Drizzle Integration (Shared Database)

If you're already using Drizzle ORM, TypeGraph can share your existing database
connection. TypeGraph tables coexist alongside your application tables.

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresBackend, getPostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";
import { createStore } from "@nicia-ai/typegraph";

// Your existing Drizzle setup
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// Add TypeGraph tables to your existing database
await pool.query(getPostgresMigrationSQL());

// Create TypeGraph backend using the same connection
const backend = createPostgresBackend(db);
const store = createStore(graph, backend);

// For pure TypeGraph operations, use store.transaction()
await store.transaction(async (tx) => {
  const person = await tx.nodes.Person.create({ name: "Alice" });
  const company = await tx.nodes.Company.create({ name: "Acme" });
  await tx.edges.worksAt.create(person, company, { role: "Engineer" });
});
```

### Mixed Drizzle + TypeGraph Transactions

When combining TypeGraph operations with direct Drizzle queries in the same atomic transaction,
create a temporary backend from the Drizzle transaction:

```typescript
await db.transaction(async (tx) => {
  // Direct Drizzle operations
  await tx.insert(auditLog).values({ action: "user_created" });

  // TypeGraph operations in the same transaction
  const txBackend = createPostgresBackend(tx);
  const txStore = createStore(graph, txBackend);
  await txStore.nodes.Person.create({ name: "Alice" });
});
```

This pattern is only needed when you must combine both in one atomic transaction.

**When to use:**

- You want a single database to manage
- Your graph data relates to existing tables
- You need cross-cutting transactions

**Considerations:**

- TypeGraph tables use the `typegraph_` prefix to avoid collisions
- Run TypeGraph migrations alongside your application migrations
- Connection pool is shared, so size accordingly

## Drizzle-Kit Managed Migrations (Recommended)

If you use `drizzle-kit` to manage migrations, you can import TypeGraph's table
definitions directly into your schema file. This lets drizzle-kit generate
migrations for all tables—both yours and TypeGraph's—in one place.

### Setup

**1. Import TypeGraph tables into your schema:**

```typescript
// schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Import TypeGraph tables (these are standard Drizzle table definitions)
export * from "@nicia-ai/typegraph/drizzle/schema/sqlite";
// Or for PostgreSQL:
// export * from "@nicia-ai/typegraph/drizzle/schema/postgres";

// Your application tables
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
});
```

**2. Generate migrations normally:**

```bash
npx drizzle-kit generate
```

Drizzle-kit will now see all tables—TypeGraph's and yours—and generate migrations
for them.

**3. Apply migrations:**

```bash
npx drizzle-kit migrate
# Or for Cloudflare D1:
wrangler d1 migrations apply your-database
```

**4. Create the backend:**

```typescript
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createSqliteBackend, tables } from "@nicia-ai/typegraph/drizzle/sqlite";
import { createStore } from "@nicia-ai/typegraph";

const sqlite = new Database("app.db");
const db = drizzle(sqlite);

// Use the same tables that drizzle-kit manages
const backend = createSqliteBackend(db, { tables });
const store = createStore(graph, backend);
```

### Custom Table Names

To avoid conflicts or match your naming conventions, use the factory function:

```typescript
// schema.ts
import { createSqliteTables } from "@nicia-ai/typegraph/drizzle/schema/sqlite";

// Create tables with custom names
export const typegraphTables = createSqliteTables({
  nodes: "myapp_graph_nodes",
  edges: "myapp_graph_edges",
  uniques: "myapp_graph_uniques",
  schemaVersions: "myapp_graph_schema_versions",
  embeddings: "myapp_graph_embeddings",
});

// Export individual tables for drizzle-kit
export const {
  nodes: myappGraphNodes,
  edges: myappGraphEdges,
  uniques: myappGraphUniques,
  schemaVersions: myappGraphSchemaVersions,
  embeddings: myappGraphEmbeddings,
} = typegraphTables;
```

Then pass the same tables to the backend:

```typescript
import { createSqliteBackend } from "@nicia-ai/typegraph/drizzle/sqlite";
import { typegraphTables } from "./schema";

const backend = createSqliteBackend(db, { tables: typegraphTables });
```

### Adding TypeGraph Indexes

The table factory functions also accept `indexes`, which drizzle-kit will include in migrations:

```ts
// schema.ts
import { createSqliteTables } from "@nicia-ai/typegraph/drizzle/schema/sqlite";
import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";

import { Person } from "./graph";

const personEmail = defineNodeIndex(Person, { fields: ["email"] });

export const typegraphTables = createSqliteTables({}, { indexes: [personEmail] });
```

For PostgreSQL, use `createPostgresTables` from `@nicia-ai/typegraph/drizzle/schema/postgres`.
See [Indexes](/performance/indexes) for covering fields, partial indexes, and profiler integration.

If you only need PostgreSQL adapter exports, import from `@nicia-ai/typegraph/drizzle/postgres`:

```typescript
import { createPostgresBackend, tables } from "@nicia-ai/typegraph/drizzle/postgres";
```

### PostgreSQL with pgvector

For PostgreSQL with vector search, ensure the pgvector extension is enabled
before running migrations:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Then in your schema:

```typescript
// schema.ts
export * from "@nicia-ai/typegraph/drizzle/schema/postgres";
export const users = pgTable("users", { ... });
```

**When to use:**

- You already use drizzle-kit for migrations
- You want a single migration workflow for all tables
- You need Cloudflare D1 or other platforms that require drizzle-kit migrations

**Advantages over raw SQL migrations:**

- Single source of truth for schema
- Type-safe schema in TypeScript
- Drizzle-kit handles migration diffs automatically
- Works with all drizzle-kit supported platforms

## Separate Database

Use a dedicated database when you want isolation between your application data
and graph data.

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend, getPostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

// Application database (your existing setup)
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const appDb = drizzle(appPool);

// Dedicated TypeGraph database
const graphPool = new Pool({ connectionString: process.env.GRAPH_DATABASE_URL });
const graphDb = drizzle(graphPool);

await graphPool.query(getPostgresMigrationSQL());
const backend = createPostgresBackend(graphDb);
const store = createStore(graph, backend);
```

**When to use:**

- Your primary database doesn't support required features (e.g., pgvector)
- You want independent scaling for graph operations
- Compliance requires data separation
- You're adding graph capabilities to a legacy system

**Considerations:**

- No cross-database transactions (use eventual consistency patterns)
- Sync data between databases via application logic or events
- Separate backup/restore procedures

## In-Memory (Ephemeral Graphs)

Use in-memory SQLite for temporary graphs, caching, or computation.

```typescript
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite";

function createEphemeralStore(graph: GraphDef) {
  const { backend } = createLocalSqliteBackend();
  return createStore(graph, backend);
}

// Use case: Build a temporary graph for computation
async function computeRecommendations(userId: string): Promise<Recommendation[]> {
  const tempStore = createEphemeralStore(recommendationGraph);

  // Load relevant data into temporary graph
  const userData = await fetchUserData(userId);
  await populateGraph(tempStore, userData);

  // Run graph algorithms
  const results = await tempStore
    .query()
    .from("User", "u")
    .whereNode("u", (u) => u.id.eq(userId))
    .traverse("similar", "s")
    .to("Product", "p")
    .select((ctx) => ctx.p)
    .execute();

  return results;
}
```

**When to use:**

- Temporary computation graphs
- Request-scoped graph state
- Graph-based caching with expiration
- Isolated test fixtures

**Considerations:**

- Data lost on process termination
- Memory usage scales with graph size
- No persistence—rebuild on restart

## Hybrid Overlay (Graph on Existing Data)

Add graph relationships on top of existing relational data without migrating
your data model. Your existing tables remain the source of truth; TypeGraph
stores only the relationships and graph-specific metadata.

Use the `externalRef()` helper to create type-safe references to external tables:

```typescript
import {
  createExternalRef,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  externalRef,
} from "@nicia-ai/typegraph";
import { z } from "zod";

// Define nodes that reference your existing tables
const User = defineNode("User", {
  schema: z.object({
    // Type-safe reference to your existing users table
    source: externalRef("users"),
    // Denormalized fields for graph queries (optional)
    displayName: z.string().optional(),
  }),
});

const Document = defineNode("Document", {
  schema: z.object({
    source: externalRef("documents"),
    embedding: embedding(1536).optional(),
  }),
});

// Graph-only relationships not in your relational schema
const relatedTo = defineEdge("relatedTo", {
  schema: z.object({
    relationship: z.enum(["cites", "extends", "contradicts"]),
    confidence: z.number().min(0).max(1),
  }),
});

const authored = defineEdge("authored");

const graph = defineGraph({
  id: "document_graph",
  nodes: { User, Document },
  edges: {
    relatedTo: { type: relatedTo, from: [Document], to: [Document] },
    authored: { type: authored, from: [User], to: [Document] },
  },
});
```

The `externalRef()` helper validates that references include both the table name
and ID, catching errors at insert time:

```typescript
// Valid: includes table and id
await store.nodes.Document.create({
  source: { table: "documents", id: "doc_123" },
});

// Error: wrong table name (caught by TypeScript and runtime validation)
await store.nodes.Document.create({
  source: { table: "users", id: "doc_123" }, // Type error!
});

// Use createExternalRef() for a cleaner API
const docRef = createExternalRef("documents");
await store.nodes.Document.create({
  source: docRef("doc_456"),
});
```

**Syncing with external data:**

```typescript
// Sync helper: Create or update graph node from app data
async function syncDocument(store: Store, appDocument: AppDocument) {
  const existing = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.source.get("id").eq(appDocument.id))
    .select((ctx) => ctx.d)
    .first();

  if (existing) {
    await store.nodes.Document.update(existing.id, {
      embedding: await generateEmbedding(appDocument.content),
    });
    return existing;
  }

  return store.nodes.Document.create({
    source: { table: "documents", id: appDocument.id },
    embedding: await generateEmbedding(appDocument.content),
  });
}

// Query combining graph traversal with app data hydration
async function findRelatedDocuments(documentId: string) {
  // Get graph relationships
  const related = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.source.get("id").eq(documentId))
    .traverse("relatedTo", "r")
    .to("Document", "related")
    .select((ctx) => ({
      source: ctx.related.source,
      relationship: ctx.r.relationship,
      confidence: ctx.r.confidence,
    }))
    .execute();

  // Hydrate with full data from app database
  const externalIds = related.map((r) => r.source.id);
  const fullDocuments = await appDb
    .select()
    .from(documents)
    .where(inArray(documents.id, externalIds));

  return related.map((r) => ({
    ...r,
    document: fullDocuments.find((d) => d.id === r.source.id),
  }));
}
```

**When to use:**

- Adding graph capabilities to an existing application
- Semantic search over existing content
- Relationship discovery without schema changes
- Gradual migration from relational to graph thinking

**Considerations:**

- Maintain sync between app data and graph nodes
- Decide what to denormalize (tradeoff: query speed vs. sync complexity)
- The `table` field in `externalRef` enables referencing multiple external sources

## Background Embedding Workers

Decouple embedding generation from request handling using background jobs.

```typescript
// job-queue.ts - Define the embedding job
interface EmbeddingJob {
  nodeType: string;
  nodeId: string;
  content: string;
}

// worker.ts - Process embedding jobs
import { createStore } from "@nicia-ai/typegraph";

async function processEmbeddingJob(job: EmbeddingJob) {
  const { nodeType, nodeId, content } = job;

  // Generate embedding (expensive operation)
  const embedding = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: content,
  });

  // Update the node
  const collection = store.nodes[nodeType as keyof typeof store.nodes];
  await collection.update(nodeId, {
    embedding: embedding.data[0].embedding,
  });
}

// api-handler.ts - Enqueue jobs on create/update
async function createDocument(data: DocumentInput) {
  // Create node without embedding (fast)
  const doc = await store.nodes.Document.create({
    title: data.title,
    content: data.content,
    // embedding: undefined - will be populated by worker
  });

  // Enqueue embedding job (non-blocking)
  await jobQueue.add("generate-embedding", {
    nodeType: "Document",
    nodeId: doc.id,
    content: data.content,
  });

  return doc;
}
```

**Batch processing for bulk imports:**

```typescript
async function backfillEmbeddings(batchSize = 100) {
  let processed = 0;

  while (true) {
    // Find nodes missing embeddings
    const nodes = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) => d.embedding.isNull())
      .select((ctx) => ({
        id: ctx.d.id,
        content: ctx.d.content,
      }))
      .limit(batchSize)
      .execute();

    if (nodes.length === 0) break;

    // Batch embed
    const embeddings = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: nodes.map((n) => n.content),
    });

    // Batch update
    await store.transaction(async (tx) => {
      for (const [i, node] of nodes.entries()) {
        await tx.nodes.Document.update(node.id, {
          embedding: embeddings.data[i].embedding,
        });
      }
    });

    processed += nodes.length;
    console.log(`Processed ${processed} documents`);
  }
}
```

**When to use:**

- Embedding generation is slow (100-500ms per call)
- You want fast API response times
- Bulk importing existing content
- Retry logic for API failures

**Considerations:**

- Handle job failures and retries
- Consider rate limits on embedding APIs
- Queries on `embedding` should handle null values during population

## Testing Strategy

Use different backends for different test scenarios.

```typescript
// test-utils.ts
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite";

export function createTestStore(graph: GraphDef) {
  const { backend } = createLocalSqliteBackend();
  return createStore(graph, backend);
}

// Unit tests - isolated in-memory stores
describe("Document relationships", () => {
  let store: Store<typeof graph>;

  beforeEach(() => {
    store = createTestStore(graph);
  });

  it("creates bidirectional citations", async () => {
    const doc1 = await store.nodes.Document.create({ title: "Paper A" });
    const doc2 = await store.nodes.Document.create({ title: "Paper B" });

    await store.edges.cites.create(doc1, doc2, {});

    const citations = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) => d.id.eq(doc1.id))
      .traverse("cites", "c")
      .to("Document", "cited")
      .select((ctx) => ctx.cited.title)
      .execute();

    expect(citations).toEqual(["Paper B"]);
  });
});

// Integration tests - separate test database
describe("Integration: PostgreSQL", () => {
  let store: Store<typeof graph>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query(getPostgresMigrationSQL());
    const db = drizzle(pool);
    const backend = createPostgresBackend(db);
    store = createStore(graph, backend);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clean tables between tests
    await pool.query("TRUNCATE typegraph_nodes, typegraph_edges CASCADE");
  });

  it("handles concurrent writes", async () => {
    const creates = Array.from({ length: 100 }, (_, i) =>
      store.nodes.Document.create({ title: `Doc ${i}` })
    );
    await Promise.all(creates);

    const count = await store
      .query()
      .from("Document", "d")
      .select((ctx) => ctx.d)
      .execute();

    expect(count).toHaveLength(100);
  });
});
```

**Testing pyramid:**

- **Unit tests**: In-memory SQLite, fast, isolated
- **Integration tests**: Real database (PostgreSQL/SQLite file), test concurrency and constraints
- **E2E tests**: Production-like setup with full stack

## Deployment Patterns

### Edge and Serverless

Deploy TypeGraph at the edge using SQLite-compatible runtimes.

> **Note:** Edge environments cannot use `@nicia-ai/typegraph/sqlite` because it
> depends on `better-sqlite3`, a native Node.js addon. Instead, use
> `@nicia-ai/typegraph/drizzle/sqlite` which is driver-agnostic.

**Cloudflare Workers with D1:**

```typescript
// worker.ts
import { drizzle } from "drizzle-orm/d1";
import { createSqliteBackend } from "@nicia-ai/typegraph/drizzle/sqlite";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = drizzle(env.DB);
    const backend = createSqliteBackend(db);
    const store = createStore(graph, backend);

    // Handle request with graph queries
    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) => d.embedding.similarTo(queryEmbedding, 5))
      .select((ctx) => ctx.d)
      .execute();

    return Response.json(results);
  },
};
```

**Turso (libSQL):**

```typescript
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createSqliteBackend } from "@nicia-ai/typegraph/drizzle/sqlite";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const db = drizzle(client);
const backend = createSqliteBackend(db);
const store = createStore(graph, backend);
```

> For Turso and D1, use [drizzle-kit managed migrations](#drizzle-kit-managed-migrations-recommended)
> to set up the schema.

**Bun with built-in SQLite:**

Bun runs locally, so you can use the Node.js-compatible path with better-sqlite3, or
use bun:sqlite with drizzle-kit managed migrations:

```typescript
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createSqliteBackend } from "@nicia-ai/typegraph/drizzle/sqlite";

const sqlite = new Database("app.db");
const db = drizzle(sqlite);
const backend = createSqliteBackend(db);
const store = createStore(graph, backend);
```

> Use [drizzle-kit managed migrations](#drizzle-kit-managed-migrations-recommended)
> to set up the schema with bun:sqlite.

**When to use:**

- Low-latency requirements (data close to users)
- Serverless functions with graph queries
- Read-heavy workloads

**Considerations:**

- SQLite limitations (single-writer, no pgvector)
- Cold start times include DB initialization
- sqlite-vec for vector search (cosine/L2 only)

### Read Replica Separation

Route heavy graph queries to read replicas while writes go to primary.

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";

// Primary for writes
const primaryPool = new Pool({
  connectionString: process.env.PRIMARY_DATABASE_URL,
  max: 10,
});
const primaryDb = drizzle(primaryPool);
const primaryBackend = createPostgresBackend(primaryDb);
const primaryStore = createStore(graph, primaryBackend);

// Replica for reads
const replicaPool = new Pool({
  connectionString: process.env.REPLICA_DATABASE_URL,
  max: 50, // Higher pool for read-heavy workloads
});
const replicaDb = drizzle(replicaPool);
const replicaBackend = createPostgresBackend(replicaDb);
const replicaStore = createStore(graph, replicaBackend);

// Route based on operation
export const stores = {
  write: primaryStore,
  read: replicaStore,
};

// Usage
async function searchDocuments(query: string) {
  // Read from replica
  return stores.read
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.embedding.similarTo(queryEmbedding, 10))
    .select((ctx) => ctx.d)
    .execute();
}

async function createDocument(data: DocumentInput) {
  // Write to primary
  return stores.write.nodes.Document.create(data);
}
```

**When to use:**

- Heavy read workloads (semantic search, graph traversals)
- Write/read ratio is heavily skewed toward reads
- Need to scale read capacity independently

**Considerations:**

- Replication lag means reads may be slightly stale
- Don't use replica for read-after-write scenarios
- Monitor replication lag in production

### Multi-Tenant Architecture

Three approaches for multi-tenant deployments, each with different tradeoffs.

#### Option 1: Shared tables with tenant isolation (simplest)

```typescript
import { defineNode, defineGraph } from "@nicia-ai/typegraph";

// Include tenantId in your node schemas
const Document = defineNode("Document", {
  schema: z.object({
    tenantId: z.string(),
    title: z.string(),
    content: z.string(),
  }),
});

// Always filter by tenant in queries
function createTenantQuery(store: Store, tenantId: string) {
  return {
    searchDocuments: (query: string) =>
      store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) =>
          d.tenantId.eq(tenantId).and(
            d.embedding.similarTo(queryEmbedding, 10)
          )
        )
        .select((ctx) => ctx.d)
        .execute(),

    createDocument: (data: Omit<DocumentInput, "tenantId">) =>
      store.nodes.Document.create({ ...data, tenantId }),
  };
}

// Middleware extracts tenant and creates scoped API
function withTenant(req: Request) {
  const tenantId = req.headers.get("x-tenant-id")!;
  return createTenantQuery(store, tenantId);
}
```

#### Option 2: Schema per tenant (PostgreSQL)

```typescript
import { sql } from "drizzle-orm";

async function createTenantStore(tenantId: string) {
  const schemaName = `tenant_${tenantId}`;

  // Create schema if not exists
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

  // Run migrations in tenant schema
  await pool.query(`SET search_path TO ${schemaName}`);
  await pool.query(getPostgresMigrationSQL());
  await pool.query(`SET search_path TO public`);

  // Create Drizzle instance with schema
  const db = drizzle(pool, { schema: { schemaName } });
  const backend = createPostgresBackend(db);
  return createStore(graph, backend);
}

// Cache tenant stores
const tenantStores = new Map<string, Store>();

async function getTenantStore(tenantId: string): Promise<Store> {
  if (!tenantStores.has(tenantId)) {
    tenantStores.set(tenantId, await createTenantStore(tenantId));
  }
  return tenantStores.get(tenantId)!;
}
```

#### Option 3: Database per tenant (strongest isolation)

```typescript
interface TenantConfig {
  id: string;
  databaseUrl: string;
}

async function createTenantStore(config: TenantConfig) {
  const pool = new Pool({ connectionString: config.databaseUrl });
  await pool.query(getPostgresMigrationSQL());

  const db = drizzle(pool);
  const backend = createPostgresBackend(db);
  return {
    store: createStore(graph, backend),
    close: () => pool.end(),
  };
}

// Connection manager with LRU eviction
class TenantConnectionManager {
  private stores = new Map<string, { store: Store; close: () => Promise<void> }>();
  private maxConnections = 100;

  async getStore(tenantId: string): Promise<Store> {
    if (!this.stores.has(tenantId)) {
      if (this.stores.size >= this.maxConnections) {
        await this.evictOldest();
      }
      const config = await fetchTenantConfig(tenantId);
      this.stores.set(tenantId, await createTenantStore(config));
    }
    return this.stores.get(tenantId)!.store;
  }

  private async evictOldest() {
    const [oldestId, oldest] = this.stores.entries().next().value;
    await oldest.close();
    this.stores.delete(oldestId);
  }
}
```

**Comparison:**

| Approach | Isolation | Complexity | Scaling | Cost |
|----------|-----------|------------|---------|------|
| Shared tables | Low (row-level) | Low | Single DB | Lowest |
| Schema per tenant | Medium | Medium | Single DB, separate schemas | Low |
| Database per tenant | High | High | Independent DBs | Highest |

**When to use each:**

- **Shared tables**: SaaS with many small tenants, cost-sensitive
- **Schema per tenant**: Moderate isolation needs, PostgreSQL only
- **Database per tenant**: Enterprise customers requiring data isolation, compliance requirements

## Next Steps

- [Quick Start](/getting-started) - Basic setup and first graph
- [Semantic Search](/semantic-search) - Vector embeddings and similarity
- [Performance](/performance/overview) - Optimization strategies
