---
title: Multiple Graphs
description: Using separate graph definitions for different domains in the same application
---

TypeGraph supports multiple graphs for applications that have distinct data domains that benefit from separate graph definitions.

## When to Use Multiple Graphs

Use separate graphs when you have:

- **Distinct domains**: A RAG system for documents and a business network for suppliers have different node types,
  edge semantics, and query patterns
- **Independent lifecycles**: One graph might evolve rapidly while another is stable
- **Team ownership**: Different teams own different graphs, with separate schema review processes
- **Different retention policies**: Document chunks might be ephemeral while business relationships are long-lived

**Don't use multiple graphs** when:

- You need cross-graph queries or traversals (use a single graph with ontology relations instead)
- The domains are closely related (e.g., Users and Documents that Users author)
- You're trying to solve multi-tenancy (use tenant isolation patterns instead)

## Example: Documents and Business Network

A company needs two graphs:

1. **Documents graph**: Powers semantic search over internal documents
2. **Organization graph**: Tracks suppliers, partners, and contracts

### Defining the Graphs

```typescript
// graphs/documents.ts
import { z } from "zod";
import { defineNode, defineEdge, defineGraph, embedding } from "@nicia-ai/typegraph";

const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    source: z.string(),
    createdAt: z.string().datetime(),
  }),
});

const Chunk = defineNode("Chunk", {
  schema: z.object({
    content: z.string(),
    embedding: embedding(1536),
    position: z.number().int(),
  }),
});

const hasChunk = defineEdge("hasChunk");

export const documentsGraph = defineGraph({
  id: "documents",
  nodes: {
    Document: { type: Document },
    Chunk: { type: Chunk },
  },
  edges: {
    hasChunk: { type: hasChunk, from: [Document], to: [Chunk] },
  },
});
```

```typescript
// graphs/organization.ts
import { z } from "zod";
import { defineNode, defineEdge, defineGraph, subClassOf } from "@nicia-ai/typegraph";

const Organization = defineNode("Organization", {
  schema: z.object({
    name: z.string(),
    domain: z.string().optional(),
  }),
});

const Supplier = defineNode("Supplier", {
  schema: z.object({
    name: z.string(),
    domain: z.string().optional(),
    category: z.enum(["materials", "services", "logistics"]),
  }),
});

const Partner = defineNode("Partner", {
  schema: z.object({
    name: z.string(),
    domain: z.string().optional(),
    partnershipLevel: z.enum(["bronze", "silver", "gold"]),
  }),
});

const Contract = defineNode("Contract", {
  schema: z.object({
    title: z.string(),
    value: z.number(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime().optional(),
    status: z.enum(["draft", "active", "expired"]).default("draft"),
  }),
});

const supplies = defineEdge("supplies");
const hasContract = defineEdge("hasContract");

export const organizationGraph = defineGraph({
  id: "organization",
  nodes: {
    Organization: { type: Organization },
    Supplier: { type: Supplier },
    Partner: { type: Partner },
    Contract: { type: Contract },
  },
  edges: {
    supplies: { type: supplies, from: [Supplier], to: [Organization] },
    hasContract: { type: hasContract, from: [Organization], to: [Contract] },
  },
  ontology: [
    subClassOf(Supplier, Organization),
    subClassOf(Partner, Organization),
  ],
});
```

### Creating Stores

Both graphs can share the same database backend. Each graph's data is isolated by its `id`.

```typescript
// stores.ts
import { createStore } from "@nicia-ai/typegraph";
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { documentsGraph } from "./graphs/documents";
import { organizationGraph } from "./graphs/organization";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const backend = createPostgresBackend(db);

// Same backend, different stores
export const documentsStore = createStore(documentsGraph, backend);
export const organizationStore = createStore(organizationGraph, backend);
```

### Using the Stores

Each store is fully independent with its own typed API:

```typescript
// Semantic search in documents
async function searchDocuments(query: string, embedding: number[]) {
  return documentsStore
    .query()
    .from("Chunk", "c")
    .whereNode("c", (c) => c.embedding.similarTo(embedding, 10))
    .select((ctx) => ({
      content: ctx.c.content,
      position: ctx.c.position,
    }))
    .execute();
}

// Business queries in organization
async function getActiveSuppliers(category: string) {
  return organizationStore
    .query()
    .from("Supplier", "s")
    .whereNode("s", (s) => s.category.eq(category))
    .traverse("hasContract", "e")
    .to("Contract", "c")
    .whereNode("c", (c) => c.status.eq("active"))
    .select((ctx) => ({
      supplier: ctx.s.name,
      contract: ctx.c.title,
      value: ctx.c.value,
    }))
    .execute();
}
```

## Coordinating Across Graphs

Since cross-graph queries aren't supported, coordinate at the application level.

### Shared Identifiers

Use consistent IDs when entities relate across graphs:

```typescript
// When ingesting a supplier's documents, use the supplier ID as a reference
async function ingestSupplierDocument(
  supplierId: string,
  title: string,
  content: string,
  embedding: number[]
) {
  // Store document with supplier reference in metadata
  const doc = await documentsStore.nodes.Document.create({
    title,
    source: `supplier:${supplierId}`,
    createdAt: new Date().toISOString(),
  });

  const chunk = await documentsStore.nodes.Chunk.create({
    content,
    embedding,
    position: 0,
  });

  await documentsStore.edges.hasChunk.create(doc, chunk, {});

  return doc;
}

// Later, find documents for a supplier
async function getSupplierDocuments(supplierId: string) {
  return documentsStore
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.source.eq(`supplier:${supplierId}`))
    .select((ctx) => ctx.d)
    .execute();
}
```

### Application-Level Joins

Combine results from multiple graphs in your application:

```typescript
interface SupplierWithDocuments {
  supplier: { name: string; category: string };
  documents: Array<{ title: string }>;
}

async function getSupplierOverview(
  supplierId: string
): Promise<SupplierWithDocuments> {
  // Parallel queries to both graphs
  const [supplier, documents] = await Promise.all([
    organizationStore.nodes.Supplier.getById(supplierId),
    getSupplierDocuments(supplierId),
  ]);

  return {
    supplier: {
      name: supplier.name,
      category: supplier.category,
    },
    documents: documents.map((d) => ({ title: d.title })),
  };
}
```

### Event-Driven Sync

For loose coupling, use events to keep graphs in sync:

```typescript
// When a supplier is created, set up document ingestion
eventBus.on("supplier.created", async (event) => {
  const { supplierId, name } = event.payload;

  // Create a placeholder document node for future ingestion
  await documentsStore.nodes.Document.create({
    title: `${name} - Supplier Profile`,
    source: `supplier:${supplierId}`,
    createdAt: new Date().toISOString(),
  });
});

// When a supplier is deleted, clean up related documents
eventBus.on("supplier.deleted", async (event) => {
  const { supplierId } = event.payload;

  const docs = await documentsStore
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.source.eq(`supplier:${supplierId}`))
    .select((ctx) => ctx.d.id)
    .execute();

  for (const docId of docs) {
    await documentsStore.nodes.Document.delete(docId);
  }
});
```

## Separate Backends

For stronger isolation, use separate database connections:

```typescript
// Documents in PostgreSQL with pgvector for embeddings
const documentsPool = new Pool({
  connectionString: process.env.DOCUMENTS_DATABASE_URL,
});
const documentsBackend = createPostgresBackend(drizzle(documentsPool));
export const documentsStore = createStore(documentsGraph, documentsBackend);

// Organization data in a separate database
const orgPool = new Pool({
  connectionString: process.env.ORG_DATABASE_URL,
});
const orgBackend = createPostgresBackend(drizzle(orgPool));
export const organizationStore = createStore(organizationGraph, orgBackend);
```

**When to separate backends:**

- Different performance profiles (vector search vs. relational queries)
- Compliance requirements (PII in one database, analytics in another)
- Independent scaling needs
- Different backup/retention policies

## Schema Management

Each graph has independent schema versioning:

```typescript
import { createStoreWithSchema } from "@nicia-ai/typegraph";

// Each graph tracks its own schema version
const [documentsStore, docsSchemaResult] = await createStoreWithSchema(
  documentsGraph,
  backend
);

const [orgStore, orgSchemaResult] = await createStoreWithSchema(
  organizationGraph,
  backend
);

// Check migration status independently
if (docsSchemaResult.status === "migrated") {
  console.log("Documents schema was migrated");
}

if (orgSchemaResult.status === "migrated") {
  console.log("Organization schema was migrated");
}
```

## Caveats

**No cross-graph queries**: You cannot traverse from a node in one graph to a node in another. If you need this, consider:

- Merging the graphs into one with clear ontology separation
- Using application-level joins as shown above

**Separate ontology closures**: Each graph computes its own `subClassOf`, `implies`, etc. closures. Ontology relations
don't span graphs.

**Independent transactions**: A transaction in one store doesn't include the other. For cross-graph consistency, use
sagas or eventual consistency patterns.

**Shared tables**: When using the same backend, both graphs write to the same `typegraph_nodes` and `typegraph_edges`
tables, differentiated by `graph_id`. This is fine for most cases but means a database-level issue affects both
graphs.

## Next Steps

- [Multi-Tenant SaaS](./examples/multi-tenant) - Isolating data by tenant within a single graph
- [Schema Migrations](./schema-management) - Versioning and migrations
- [Integration Patterns](./integration) - More deployment strategies
