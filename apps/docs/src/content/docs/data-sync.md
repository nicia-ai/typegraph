---
title: Data Sync Patterns
description: Strategies for synchronizing external data with your TypeGraph store
---

When adding TypeGraph as a graph overlay to an existing application, you need
to keep your graph data in sync with your source of truth. This guide covers
practical patterns for syncing external data into TypeGraph using the bulk
operations API.

## Overview

Most applications adding TypeGraph will have existing data in relational tables,
external APIs, or document stores. Rather than migrating this data, TypeGraph
works alongside it as an overlay that provides:

- Graph traversals across your existing entities
- Semantic search via vector embeddings
- Relationship discovery and inference

The key challenge is keeping the graph in sync with your source data. We cover three approaches:

| Approach | Best For | Complexity |
|----------|----------|------------|
| [On-demand sync](#on-demand-sync) | Low-volume, real-time needs | Low |
| [Batch sync](#batch-sync) | Bulk imports, periodic refresh | Medium |
| [Event-driven sync](#event-driven-sync) | High-volume, near-real-time | Higher |

## Bulk Operations API

TypeGraph provides bulk operations for efficient sync workflows:

```typescript
// Create or update a single node
await store.nodes.Document.upsertById(id, props);

// Create many nodes at once
await store.nodes.Document.bulkCreate(items);

// Insert many nodes without returning results (dedicated fast path)
await store.nodes.Document.bulkInsert(items);

// Create or update many nodes at once
await store.nodes.Document.bulkUpsertById(items);

// Delete many nodes at once
await store.nodes.Document.bulkDelete(ids);
```

### upsertById

Creates a node if it doesn't exist, or updates it if it does. This includes
"un-deleting" soft-deleted nodes:

```typescript
// First call creates the node
const doc1 = await store.nodes.Document.upsertById("doc_123", {
  title: "Original Title",
  content: "...",
});

// Second call updates the existing node
const doc2 = await store.nodes.Document.upsertById("doc_123", {
  title: "Updated Title",
  content: "...",
});

// doc1.id === doc2.id - same node, updated in place
```

### bulkCreate

Efficiently creates multiple nodes in a single operation. Uses a single
multi-row INSERT with RETURNING when the backend supports it:

```typescript
const documents = await store.nodes.Document.bulkCreate([
  { props: { title: "Doc 1", content: "..." } },
  { props: { title: "Doc 2", content: "..." } },
  { props: { title: "Doc 3", content: "..." }, id: "custom_id" },
]);
```

If you only need write side effects and not created payloads, use `bulkInsert`.

### bulkInsert

Inserts multiple nodes without returning results. This is the dedicated fast path
for bulk ingestion — automatically wrapped in a transaction:

```typescript
await store.nodes.Document.bulkInsert([
  { props: { title: "Doc 1", content: "..." } },
  { props: { title: "Doc 2", content: "..." } },
  { props: { title: "Doc 3", content: "..." }, id: "custom_id" },
]);
```

Prefer `bulkInsert` over `bulkCreate` when you don't need results.

### bulkUpsertById

Creates or updates multiple nodes. Ideal for sync workflows where you don't
know which records already exist:

```typescript
// Sync a batch of external records
const externalRecords = await fetchExternalData();

const synced = await store.nodes.Document.bulkUpsertById(
  externalRecords.map((record) => ({
    id: record.id, // Use external ID as graph node ID
    props: {
      title: record.title,
      content: record.body,
      source: { table: "documents", id: record.id },
    },
  }))
);
```

### bulkDelete

Deletes multiple nodes by ID. Silently ignores IDs that don't exist:

```typescript
// Remove nodes that no longer exist in source
const deletedIds = await findDeletedRecords();
await store.nodes.Document.bulkDelete(deletedIds);
```

### getOrCreate APIs

Use get-or-create methods when your dedupe key is not a direct ID:

```typescript
// Match by a named uniqueness constraint
const byEmail = await store.nodes.User.getOrCreateByConstraint(
  "user_email",
  { email: "alice@example.com", name: "Alice" },
  { ifExists: "update" }
);
// byEmail.action: "created" | "found" | "updated" | "resurrected"

// Match edges by endpoints (+ optional matchOn fields)
const membership = await store.edges.memberOf.getOrCreateByEndpoints(
  user,
  org,
  { role: "admin", source: "sync" },
  { matchOn: ["role"], ifExists: "update" }
);
// membership.action: "created" | "found" | "updated" | "resurrected"
```

### Edge Bulk Operations

Edges also support bulk operations:

```typescript
// Create many edges at once (returns created edges)
const edges = await store.edges.relatedTo.bulkCreate([
  { from: doc1, to: doc2, props: { confidence: 0.9 } },
  { from: doc1, to: doc3, props: { confidence: 0.7 } },
  { from: doc2, to: doc3, props: { confidence: 0.8 } },
]);

// Insert many edges without returning results (fast path)
await store.edges.relatedTo.bulkInsert([
  { from: doc1, to: doc2, props: { confidence: 0.9 } },
  { from: doc1, to: doc3, props: { confidence: 0.7 } },
  { from: doc2, to: doc3, props: { confidence: 0.8 } },
]);

// Delete many edges at once
await store.edges.relatedTo.bulkDelete(edgeIds);
```

## On-Demand Sync

Sync individual records when they're accessed or modified. Best for low-volume
scenarios where you want real-time consistency.

```typescript
import { type Store } from "@nicia-ai/typegraph";
import { db, documents } from "./drizzle-schema";

interface AppDocument {
  id: string;
  title: string;
  content: string;
  updatedAt: Date;
}

async function syncDocument(store: Store, doc: AppDocument) {
  // Generate embedding for semantic search
  const embedding = await generateEmbedding(doc.content);

  // Upsert ensures we create or update as needed
  return store.nodes.Document.upsertById(doc.id, {
    title: doc.title,
    content: doc.content,
    embedding,
    source: { table: "documents", id: doc.id },
  });
}

// Sync on read - ensure graph is current before querying
async function getRelatedDocuments(documentId: string) {
  // First, ensure the source document is synced
  const appDoc = await db.select().from(documents).where(eq(documents.id, documentId)).get();
  if (!appDoc) throw new Error("Document not found");

  await syncDocument(store, appDoc);

  // Now query the graph for relationships
  return store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.id.eq(documentId))
    .traverse("relatedTo", "r")
    .to("Document", "related")
    .select((ctx) => ({
      id: ctx.related.id,
      title: ctx.related.title,
      confidence: ctx.r.confidence,
    }))
    .execute();
}

// Sync on write - update graph when source changes
async function updateDocument(documentId: string, updates: Partial<AppDocument>) {
  // Update source of truth first
  const [updated] = await db
    .update(documents)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(documents.id, documentId))
    .returning();

  // Then sync to graph
  await syncDocument(store, updated);

  return updated;
}
```

## Batch Sync

Process records in batches for bulk imports or periodic refresh. Best for
large datasets or when you need to backfill data.

### Basic Batch Sync

```typescript
interface SyncOptions {
  batchSize?: number;
  onProgress?: (processed: number, total: number) => void;
}

async function syncAllDocuments(store: Store, options: SyncOptions = {}) {
  const { batchSize = 100, onProgress } = options;

  // Get total count for progress reporting
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(documents);

  let processed = 0;
  let offset = 0;

  while (offset < count) {
    // Fetch a batch from source
    const batch = await db.select().from(documents).limit(batchSize).offset(offset);

    if (batch.length === 0) break;

    // Generate embeddings in parallel (respecting API rate limits)
    const embeddings = await batchGenerateEmbeddings(batch.map((d) => d.content));

    // Bulk upsert the batch
    await store.nodes.Document.bulkUpsertById(
      batch.map((doc, i) => ({
        id: doc.id,
        props: {
          title: doc.title,
          content: doc.content,
          embedding: embeddings[i],
          source: { table: "documents", id: doc.id },
        },
      }))
    );

    processed += batch.length;
    offset += batchSize;
    onProgress?.(processed, count);
  }

  return { processed, total: count };
}

// Usage
await syncAllDocuments(store, {
  batchSize: 50,
  onProgress: (processed, total) => {
    console.log(`Synced ${processed}/${total} documents`);
  },
});
```

### Incremental Sync

Only sync records that have changed since the last sync:

```typescript
interface SyncState {
  lastSyncAt: Date;
}

async function incrementalSync(store: Store, state: SyncState): Promise<SyncState> {
  const since = state.lastSyncAt;
  const now = new Date();

  // Fetch only changed records
  const changed = await db
    .select()
    .from(documents)
    .where(gt(documents.updatedAt, since))
    .orderBy(documents.updatedAt);

  if (changed.length > 0) {
    const embeddings = await batchGenerateEmbeddings(changed.map((d) => d.content));

    await store.nodes.Document.bulkUpsertById(
      changed.map((doc, i) => ({
        id: doc.id,
        props: {
          title: doc.title,
          content: doc.content,
          embedding: embeddings[i],
          source: { table: "documents", id: doc.id },
        },
      }))
    );

    console.log(`Synced ${changed.length} changed documents`);
  }

  // Handle deletions (if your source tracks them)
  const deleted = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(gt(documents.deletedAt, since), isNotNull(documents.deletedAt)));

  if (deleted.length > 0) {
    await store.nodes.Document.bulkDelete(deleted.map((d) => d.id));
    console.log(`Removed ${deleted.length} deleted documents`);
  }

  return { lastSyncAt: now };
}
```

### Scheduled Sync Job

Run incremental sync on a schedule:

```typescript
import { CronJob } from "cron";

// Store sync state (in production, persist this to a database)
let syncState: SyncState = { lastSyncAt: new Date(0) };

// Run every 5 minutes
const syncJob = new CronJob("*/5 * * * *", async () => {
  try {
    syncState = await incrementalSync(store, syncState);
  } catch (error) {
    console.error("Sync failed:", error);
    // Alert, retry, etc.
  }
});

syncJob.start();
```

## Event-Driven Sync

React to changes in your source data via events, webhooks, or database triggers.
Best for high-volume scenarios requiring near-real-time sync.

### Message Queue Pattern

```typescript
import { Queue, Worker } from "bullmq";

// Define sync job types
interface SyncJob {
  type: "upsert" | "delete";
  entityType: "Document" | "User";
  entityId: string;
}

// Producer: Enqueue sync jobs when source data changes
const syncQueue = new Queue<SyncJob>("sync");

async function onDocumentCreated(doc: AppDocument) {
  await syncQueue.add("sync", {
    type: "upsert",
    entityType: "Document",
    entityId: doc.id,
  });
}

async function onDocumentUpdated(doc: AppDocument) {
  await syncQueue.add("sync", {
    type: "upsert",
    entityType: "Document",
    entityId: doc.id,
  });
}

async function onDocumentDeleted(docId: string) {
  await syncQueue.add("sync", {
    type: "delete",
    entityType: "Document",
    entityId: docId,
  });
}

// Consumer: Process sync jobs
const syncWorker = new Worker<SyncJob>(
  "sync",
  async (job) => {
    const { type, entityType, entityId } = job.data;

    if (type === "delete") {
      await store.nodes[entityType].delete(entityId);
      return;
    }

    // Fetch current state from source
    const record = await fetchEntity(entityType, entityId);
    if (!record) {
      // Record was deleted between enqueue and processing
      await store.nodes[entityType].delete(entityId);
      return;
    }

    // Generate embedding if needed
    const embedding = await generateEmbedding(record.content);

    // Upsert to graph
    await store.nodes[entityType].upsertById(entityId, {
      ...record,
      embedding,
      source: { table: entityType.toLowerCase() + "s", id: entityId },
    });
  },
  {
    concurrency: 10,
    connection: redis,
  }
);
```

### Webhook Handler

Process webhooks from external systems:

```typescript
import { Hono } from "hono";

const app = new Hono();

app.post("/webhooks/documents", async (c) => {
  const event = await c.req.json<{
    type: "created" | "updated" | "deleted";
    data: AppDocument;
  }>();

  switch (event.type) {
    case "created":
    case "updated": {
      const embedding = await generateEmbedding(event.data.content);
      await store.nodes.Document.upsertById(event.data.id, {
        title: event.data.title,
        content: event.data.content,
        embedding,
        source: { table: "documents", id: event.data.id },
      });
      break;
    }

    case "deleted": {
      await store.nodes.Document.delete(event.data.id);
      break;
    }
  }

  return c.json({ ok: true });
});
```

### Database Triggers (PostgreSQL)

Use LISTEN/NOTIFY for real-time sync from PostgreSQL:

```typescript
import { Client } from "pg";

// Set up listener
const listener = new Client({ connectionString: process.env.DATABASE_URL });
await listener.connect();
await listener.query("LISTEN document_changes");

listener.on("notification", async (msg) => {
  if (msg.channel !== "document_changes") return;

  const payload = JSON.parse(msg.payload!);
  const { operation, id } = payload;

  if (operation === "DELETE") {
    await store.nodes.Document.delete(id);
    return;
  }

  // Fetch and sync the changed document
  const doc = await db.select().from(documents).where(eq(documents.id, id)).get();

  if (doc) {
    const embedding = await generateEmbedding(doc.content);
    await store.nodes.Document.upsertById(id, {
      title: doc.title,
      content: doc.content,
      embedding,
      source: { table: "documents", id },
    });
  }
});
```

Corresponding PostgreSQL trigger:

```sql
CREATE OR REPLACE FUNCTION notify_document_changes()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'document_changes',
    json_build_object(
      'operation', TG_OP,
      'id', COALESCE(NEW.id, OLD.id)
    )::text
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_changes_trigger
AFTER INSERT OR UPDATE OR DELETE ON documents
FOR EACH ROW EXECUTE FUNCTION notify_document_changes();
```

## Syncing Relationships

When syncing data that includes relationships, sync nodes first, then edges:

```typescript
interface ExternalUser {
  id: string;
  name: string;
  email: string;
  managerId?: string;
}

async function syncUsers(users: ExternalUser[]) {
  // Step 1: Sync all user nodes first
  await store.nodes.User.bulkUpsertById(
    users.map((u) => ({
      id: u.id,
      props: {
        name: u.name,
        email: u.email,
        source: { table: "users", id: u.id },
      },
    }))
  );

  // Step 2: Sync manager relationships
  // First, remove all existing manages edges (clean slate approach)
  const existingEdges = await store.edges.manages.find();
  if (existingEdges.length > 0) {
    await store.edges.manages.bulkDelete(existingEdges.map((e) => e.id));
  }

  // Then create edges for users with managers
  const usersWithManagers = users.filter((u) => u.managerId);

  await store.edges.manages.bulkInsert(
    usersWithManagers.map((u) => ({
      from: { kind: "User" as const, id: u.managerId! },
      to: { kind: "User" as const, id: u.id },
    })),
  );
}
```

## Handling Sync Failures

### Retry with Exponential Backoff

```typescript
async function syncWithRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelay?: number } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000 } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`Sync attempt ${attempt + 1} failed, retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// Usage
await syncWithRetry(() => store.nodes.Document.bulkUpsertById(items));
```

### Dead Letter Queue

Track failed syncs for manual intervention:

```typescript
interface FailedSync {
  entityType: string;
  entityId: string;
  error: string;
  failedAt: Date;
  attempts: number;
}

const failedSyncs: FailedSync[] = [];

async function syncWithDLQ(entityType: string, entityId: string, syncFn: () => Promise<void>) {
  try {
    await syncWithRetry(syncFn);
  } catch (error) {
    failedSyncs.push({
      entityType,
      entityId,
      error: (error as Error).message,
      failedAt: new Date(),
      attempts: 3,
    });

    console.error(`Sync failed after retries: ${entityType}:${entityId}`);
  }
}

// Periodically retry or alert on failed syncs
async function processFailedSyncs() {
  for (const failed of failedSyncs) {
    console.log(`Failed sync: ${failed.entityType}:${failed.entityId} - ${failed.error}`);
    // Retry, alert, or log for manual intervention
  }
}
```

## Best Practices

### Use Consistent IDs

Map external IDs to graph node IDs consistently:

```typescript
// Good: Use external ID directly when it's unique and stable
await store.nodes.Document.upsertById(externalDoc.id, { ... });

// Good: Namespace if IDs might collide across sources
await store.nodes.Document.upsertById(`notion:${notionPage.id}`, { ... });
await store.nodes.Document.upsertById(`gdrive:${driveFile.id}`, { ... });
```

### Track Sync Metadata

Store sync information for debugging and auditing:

```typescript
const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    content: z.string(),
    embedding: embedding(1536).optional(),
    source: externalRef("documents"),
    // Sync metadata
    lastSyncedAt: z.string().datetime().optional(),
    syncVersion: z.number().optional(),
  }),
});

await store.nodes.Document.upsertById(doc.id, {
  ...props,
  lastSyncedAt: new Date().toISOString(),
  syncVersion: (existingNode?.syncVersion ?? 0) + 1,
});
```

### Validate Before Sync

Validate external data before syncing to avoid corrupting your graph:

```typescript
const ExternalDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
});

async function syncDocument(rawDoc: unknown) {
  const result = ExternalDocumentSchema.safeParse(rawDoc);

  if (!result.success) {
    console.error("Invalid document data:", result.error);
    return;
  }

  await store.nodes.Document.upsertById(result.data.id, {
    title: result.data.title,
    content: result.data.content,
  });
}
```

### Monitor Sync Health

Track sync metrics for observability:

```typescript
const syncMetrics = {
  successful: 0,
  failed: 0,
  lastSyncDuration: 0,
  lastSyncAt: null as Date | null,
};

async function monitoredSync(fn: () => Promise<void>) {
  const start = Date.now();

  try {
    await fn();
    syncMetrics.successful++;
  } catch (error) {
    syncMetrics.failed++;
    throw error;
  } finally {
    syncMetrics.lastSyncDuration = Date.now() - start;
    syncMetrics.lastSyncAt = new Date();
  }
}

// Expose metrics endpoint
app.get("/metrics/sync", (c) => c.json(syncMetrics));
```

## Next Steps

- [Integration Patterns](/integration) - Database setup and deployment patterns
- [Semantic Search](/semantic-search) - Add vector embeddings during sync
- [Query Builder](/queries/overview) - Query your synced graph data
