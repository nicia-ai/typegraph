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
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
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

## Inspecting What a Database Holds

Graphs sharing a backend are separated by `graph_id` inside TypeGraph's tables. Two reads answer the
questions an operator asks about that layout without depending on it: which graphs live in this
database, and how many rows one graph holds.

### `listGraphIds(backend, options?)`

Lists the graph ids that hold data, one bounded page at a time:

```typescript
import { listGraphIds } from "@nicia-ai/typegraph";

let after: string | undefined;
for (;;) {
  const page = await listGraphIds(backend, { prefix: "tenant-", after, limit: 100 });
  if (page.length === 0) break;
  for (const graphId of page) console.log(graphId);
  after = page.at(-1);
}
```

| Option   | Meaning                                                                             |
| -------- | ----------------------------------------------------------------------------------- |
| `prefix` | Only ids starting with this exact, case-sensitive text. `%` and `_` are not wildcards. |
| `after`  | Exclusive cursor: only ids ordered after this one. Pass the last id of the previous page. |
| `limit`  | Page size from 1 to 1000. Defaults to 100. Anything else throws `ConfigurationError`. |

Ids come back in byte order (UTF-8 code point order) on every backend, so `Tenant-x` sorts before
`tenant-a` on SQLite and PostgreSQL alike and a cursor resumes exactly where the last page ended,
whatever the database collation. The reserved deployment marker id that TypeGraph uses for
deployment-scoped contribution markers is never listed. A graph appears while it has nodes, edges or a
committed schema version, which are exactly the relations a default `store.clear()` empties. A
cleared graph therefore stops being listed even though `store.clear()` keeps its contribution
markers unless you pass `preserveContributionMaterializations: false`, and even when a
revision-tracked store reseeded its `recordedClock` row during the clear.

Each page walks graph ids by index seek, one seek per graph per relation, instead of reading every
row. The walk starts at the cursor or prefix and stops after the page, so a page costs about `limit`
seeks wherever it sits, however many graphs the database holds and however many rows they contain.
SQLite serves the seeks from the `graph_id`-leading primary keys, which are already in byte order.
PostgreSQL orders ordinary text indexes by the database collation, so it serves them from a
byte-ordered (`COLLATE "C"`) `graph_id` index that base-schema version 5 adds to `nodes`, `edges` and
`schema_versions`; see [Base-schema version 5](/backend-setup#base-schema-version-5-byte-ordered-graph_id-indexes-postgresql)
for what it costs and how to build it ahead of an upgrade. On a 20,000-graph, 50-rows-per-graph
PostgreSQL 18 database a page takes about 3 ms, where the same read took about 400 ms before the
index; at 200 graphs of 5,000 rows it is about 3 ms either way. A database without the index (its
base schema not adopted yet, or DDL managed by hand) lists the same ids by reading and de-duplicating
every row of those relations for each page, measured at 47 to 105 ms a page at these sizes. A backend that
declares no recursive traversal does the same. Use the listing for operator tooling, not on a request
path. Rows that exist only outside those relations, such as orphaned recorded history or contribution
markers, do not make a graph appear; `inspectGraphStorage` counts every relation.

The read runs in one read-only transaction where the backend supports it. It needs the backend's
catalog probes to tell a table that was never provisioned from an empty one, and throws
`ConfigurationError` on a custom backend that has none.

### `inspectGraphStorage(store)`

Counts one graph's rows in every relation that can hold them:

```typescript
import { inspectGraphStorage } from "@nicia-ai/typegraph";

await store.clear();
const { graphId, relations, totalRows } = await inspectGraphStorage(store);

const leftovers = relations.filter((relation) => relation.rows > 0);
// [{ relation: "contributionMaterializations", table: "typegraph_contribution_materializations", rows: 2 }]
```

`relations` lists every graph-scoped relation under its logical key (`nodes`, `edges`, `uniques`,
`edgeClaims`, `identityAssertions`, `recordedNodes`, `fulltext`, `schemaVersions`, and so on) with
the physical `table` it resolved to on this backend, so custom table names are reported as
configured. The graph's per-field vector tables come from its vector slots and the active vector
strategy and are reported as `vector:<Kind>.<field>`. A relation whose table the database never
provisioned counts as `0` rather than failing.

Use it to verify that `store.clear()` left nothing behind. Two relations can legitimately hold a
row after a clear, by design:

- `contributionMaterializations` is preserved unless you pass
  `preserveContributionMaterializations: false`.
- `recordedClock` is reseeded inside the clear transaction on a store with live revision tracking
  (without history).

Every other relation reads `0` after a clear, and other graphs in the same database are untouched.

## Shared Subgraph Helpers

When multiple graphs share a common set of node and edge types, you can write reusable
helpers that accept any store containing that shared subgraph. The `StoreProjection` utility
type makes this type-safe without coupling to a specific graph definition.

### Defining shared types and graphs

Start with the shared node and edge types, then define the graphs that use them:

```typescript
import {
  createStore,
  defineNode,
  defineEdge,
  defineGraph,
  type Node,
  type StoreProjection,
} from "@nicia-ai/typegraph";

const Document = defineNode("Document", {
  schema: z.object({ title: z.string() }),
});

const Chunk = defineNode("Chunk", {
  schema: z.object({ text: z.string() }),
});

const Comment = defineNode("Comment", {
  schema: z.object({ text: z.string() }),
});

const hasChunk = defineEdge("hasChunk", { from: [Document], to: [Chunk] });
const aboutChunk = defineEdge("aboutChunk", { from: [Comment], to: [Chunk] });

const reviewGraph = defineGraph({
  id: "review",
  nodes: {
    Document: { type: Document },
    Chunk: { type: Chunk },
    Comment: { type: Comment },
    Label: { type: Label },
  },
  edges: { hasChunk, aboutChunk, hasLabel },
});

const catalogGraph = defineGraph({
  id: "catalog",
  nodes: {
    Document: {
      type: Document,
      unique: [{ name: "title_unique", fields: ["title"], scope: "kind", collation: "binary" }],
    },
    Chunk: { type: Chunk },
    Comment: { type: Comment },
    Category: { type: Category },
  },
  edges: { hasChunk, aboutChunk, inCategory },
});
```

### Projecting a shared subgraph

Define a projection against either graph — it picks only the shared keys:

```typescript
type CoreStore = StoreProjection<
  typeof reviewGraph,
  "Document" | "Chunk" | "Comment",
  "hasChunk" | "aboutChunk"
>;
```

### Writing a reusable helper

```typescript
async function addComment(
  store: CoreStore,
  chunk: Node<typeof Chunk>,
  text: string,
) {
  const comment = await store.nodes.Comment.create({ text });
  await store.edges.aboutChunk.create(comment, chunk);
  return comment;
}
```

### Using across different graphs

The same `addComment` function works with any store whose graph includes the projected
nodes and edges — even if the graphs diverge on other types or unique constraints:

```typescript
const reviewStore = createStore(reviewGraph, backend);
const catalogStore = createStore(catalogGraph, backend);

await addComment(reviewStore, chunk, "needs revision");
await addComment(catalogStore, chunk, "good categorization");
```

The projection also works inside transactions — `TransactionContext<G>` is structurally
assignable to `StoreProjection` for the same keys:

```typescript
await reviewStore.transaction(async (tx) => {
  await addComment(tx, chunk, "transactional comment");
});
```

### What the projection strips

`StoreProjection` erases node constraint names, making constraint-based methods like
`findByConstraint` uncallable through the projection. This is intentional: unique
constraints are graph-registration-level details that typically differ between graphs
sharing the same node types. If you need constraint access, type the helper against a
specific `Store<G>` instead.

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
