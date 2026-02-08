---
title: Audit Trail
description: Complete change tracking with user attribution and diff generation
---

This example shows how to build a comprehensive audit system that:

- **Tracks all changes** using TypeGraph's temporal model
- **Attributes changes** to users and sessions
- **Generates diffs** between versions
- **Supports compliance queries** (who changed what, when)
- **Exports audit logs** for external systems

## How TypeGraph Enables Auditing

TypeGraph's temporal model provides built-in auditing capabilities:

1. **Every update creates a new version** - Old data is preserved with `valid_to` timestamp
2. **Temporal queries** - Query any point in time with `asOf` or get full history with `includeEnded`
3. **Metadata fields** - `createdAt`, `updatedAt`, `version` are tracked automatically

This example extends the built-in capabilities with:

- User attribution (who made the change)
- Change descriptions (why the change was made)
- Structured diffs (what exactly changed)

## Schema Definition

```typescript
import { z } from "zod";
import { defineNode, defineEdge, defineGraph } from "@nicia-ai/typegraph";

// Audited entity (example: Settings)
const Setting = defineNode("Setting", {
  schema: z.object({
    key: z.string(),
    value: z.string(),
    category: z.string(),
    description: z.string().optional(),
  }),
});

// Users making changes
const User = defineNode("User", {
  schema: z.object({
    email: z.string().email(),
    name: z.string(),
    role: z.enum(["admin", "editor", "viewer"]),
  }),
});

// Explicit audit log entries (for cross-cutting concerns)
const AuditEntry = defineNode("AuditEntry", {
  schema: z.object({
    entityType: z.string(),
    entityId: z.string(),
    action: z.enum(["create", "update", "delete", "restore"]),
    timestamp: z.string().datetime(),
    changes: z.record(z.object({
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    })).optional(),
    reason: z.string().optional(),
    ipAddress: z.string().optional(),
    userAgent: z.string().optional(),
  }),
});

// Sessions for grouping changes
const Session = defineNode("Session", {
  schema: z.object({
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    ipAddress: z.string().optional(),
    userAgent: z.string().optional(),
  }),
});

// Edges
const performedBy = defineEdge("performedBy");
const inSession = defineEdge("inSession");
const hasSession = defineEdge("hasSession");

const graph = defineGraph({
  id: "audit_trail",
  nodes: {
    Setting: { type: Setting },
    User: { type: User },
    AuditEntry: { type: AuditEntry },
    Session: { type: Session },
  },
  edges: {
    performedBy: { type: performedBy, from: [AuditEntry], to: [User] },
    inSession: { type: inSession, from: [AuditEntry], to: [Session] },
    hasSession: { type: hasSession, from: [User], to: [Session] },
  },
});
```

## Audit Context

Create a context object to track the current user and session:

```typescript
interface AuditContext {
  userId: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  reason?: string;
}

// Thread-local storage for audit context (Node.js)
import { AsyncLocalStorage } from "async_hooks";

const auditContext = new AsyncLocalStorage<AuditContext>();

function withAuditContext<T>(context: AuditContext, fn: () => Promise<T>): Promise<T> {
  return auditContext.run(context, fn);
}

function getAuditContext(): AuditContext | undefined {
  return auditContext.getStore();
}
```

## Audited Operations

### Create with Audit

```typescript
async function createSetting(
  key: string,
  value: string,
  category: string
): Promise<Node<typeof Setting>> {
  const ctx = getAuditContext();
  if (!ctx) throw new Error("Audit context required");

  return store.transaction(async (tx) => {
    // Create the setting
    const setting = await tx.nodes.Setting.create({
      key,
      value,
      category,
    });

    // Create audit entry
    await createAuditEntry(tx, {
      entityType: "Setting",
      entityId: setting.id,
      action: "create",
      changes: {
        key: { after: key },
        value: { after: value },
        category: { after: category },
      },
    });

    return setting;
  });
}
```

### Update with Audit

```typescript
async function updateSetting(
  id: string,
  updates: Partial<{ value: string; description: string }>
): Promise<Node<typeof Setting>> {
  const ctx = getAuditContext();
  if (!ctx) throw new Error("Audit context required");

  return store.transaction(async (tx) => {
    // Get current state
    const current = await tx.nodes.Setting.getById(id);
    if (!current) throw new Error(`Setting not found: ${id}`);

    // Calculate changes
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const [key, newValue] of Object.entries(updates)) {
      const oldValue = current[key as keyof typeof current];
      if (oldValue !== newValue) {
        changes[key] = { before: oldValue, after: newValue };
      }
    }

    // Skip if no actual changes
    if (Object.keys(changes).length === 0) {
      return current;
    }

    // Update the setting
    const updated = await tx.nodes.Setting.update(id, updates);

    // Create audit entry
    await createAuditEntry(tx, {
      entityType: "Setting",
      entityId: id,
      action: "update",
      changes,
    });

    return updated;
  });
}
```

### Delete with Audit

```typescript
async function deleteSetting(id: string): Promise<void> {
  const ctx = getAuditContext();
  if (!ctx) throw new Error("Audit context required");

  await store.transaction(async (tx) => {
    // Get current state for audit
    const current = await tx.nodes.Setting.getById(id);
    if (!current) throw new Error(`Setting not found: ${id}`);

    // Delete (soft delete)
    await tx.nodes.Setting.delete(id);

    // Create audit entry
    await createAuditEntry(tx, {
      entityType: "Setting",
      entityId: id,
      action: "delete",
      changes: {
        key: { before: current.key },
        value: { before: current.value },
        category: { before: current.category },
      },
    });
  });
}
```

### Create Audit Entry

```typescript
interface AuditEntryInput {
  entityType: string;
  entityId: string;
  action: "create" | "update" | "delete" | "restore";
  changes?: Record<string, { before?: unknown; after?: unknown }>;
}

async function createAuditEntry(
  tx: Transaction,
  input: AuditEntryInput
): Promise<Node<typeof AuditEntry>> {
  const ctx = getAuditContext()!;

  const entry = await tx.nodes.AuditEntry.create({
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    timestamp: new Date().toISOString(),
    changes: input.changes,
    reason: ctx.reason,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  // Link to user
  const user = await tx.nodes.User.getById(ctx.userId);
  if (!user) throw new Error(`User not found: ${ctx.userId}`);
  await tx.edges.performedBy.create(entry, user, {});

  // Link to session if present
  if (ctx.sessionId) {
    const session = await tx.nodes.Session.getById(ctx.sessionId);
    if (!session) throw new Error(`Session not found: ${ctx.sessionId}`);
    await tx.edges.inSession.create(entry, session, {});
  }

  return entry;
}
```

## Querying Audit History

### Get Entity History

```typescript
interface HistoryEntry {
  version: number;
  timestamp: string;
  action: string;
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  user: { name: string; email: string };
  reason?: string;
}

async function getEntityHistory(
  entityType: string,
  entityId: string
): Promise<HistoryEntry[]> {
  return store
    .query()
    .from("AuditEntry", "a")
    .whereNode("a", (a) =>
      a.entityType.eq(entityType).and(a.entityId.eq(entityId))
    )
    .traverse("performedBy", "e")
    .to("User", "u")
    .orderBy((ctx) => ctx.a.timestamp, "desc")
    .select((ctx) => ({
      version: ctx.a.version,
      timestamp: ctx.a.timestamp,
      action: ctx.a.action,
      changes: ctx.a.changes,
      user: {
        name: ctx.u.name,
        email: ctx.u.email,
      },
      reason: ctx.a.reason,
    }))
    .execute();
}
```

### Get User Activity

```typescript
interface UserActivity {
  timestamp: string;
  entityType: string;
  entityId: string;
  action: string;
}

async function getUserActivity(
  userId: string,
  options: { since?: Date; limit?: number } = {}
): Promise<UserActivity[]> {
  const { since, limit = 100 } = options;

  let query = store
    .query()
    .from("User", "u")
    .whereNode("u", (u) => u.id.eq(userId))
    .traverse("performedBy", "e", { direction: "in" })
    .to("AuditEntry", "a");

  if (since) {
    query = query.whereNode("a", (a) => a.timestamp.gte(since.toISOString()));
  }

  return query
    .orderBy((ctx) => ctx.a.timestamp, "desc")
    .limit(limit)
    .select((ctx) => ({
      timestamp: ctx.a.timestamp,
      entityType: ctx.a.entityType,
      entityId: ctx.a.entityId,
      action: ctx.a.action,
    }))
    .execute();
}
```

### Changes in Time Range

```typescript
interface ChangeReport {
  entityType: string;
  entityId: string;
  changeCount: number;
  users: string[];
  lastChange: string;
}

async function getChangesInRange(
  startDate: Date,
  endDate: Date
): Promise<ChangeReport[]> {
  const entries = await store
    .query()
    .from("AuditEntry", "a")
    .whereNode("a", (a) =>
      a.timestamp.gte(startDate.toISOString()).and(
        a.timestamp.lte(endDate.toISOString())
      )
    )
    .traverse("performedBy", "e")
    .to("User", "u")
    .select((ctx) => ({
      entityType: ctx.a.entityType,
      entityId: ctx.a.entityId,
      timestamp: ctx.a.timestamp,
      userName: ctx.u.name,
    }))
    .execute();

  // Group by entity
  const grouped = new Map<string, ChangeReport>();

  for (const entry of entries) {
    const key = `${entry.entityType}:${entry.entityId}`;
    const existing = grouped.get(key);

    if (existing) {
      existing.changeCount++;
      if (!existing.users.includes(entry.userName)) {
        existing.users.push(entry.userName);
      }
      if (entry.timestamp > existing.lastChange) {
        existing.lastChange = entry.timestamp;
      }
    } else {
      grouped.set(key, {
        entityType: entry.entityType,
        entityId: entry.entityId,
        changeCount: 1,
        users: [entry.userName],
        lastChange: entry.timestamp,
      });
    }
  }

  return Array.from(grouped.values());
}
```

## Using TypeGraph's Built-in Temporal Features

### View Entity at Point in Time

```typescript
async function getSettingAsOf(
  id: string,
  timestamp: Date
): Promise<SettingProps | undefined> {
  return store
    .query()
    .from("Setting", "s")
    .temporal("asOf", timestamp.toISOString())
    .whereNode("s", (s) => s.id.eq(id))
    .select((ctx) => ctx.s)
    .first();
}
```

### Get All Versions

```typescript
interface SettingVersion {
  props: SettingProps;
  validFrom: string;
  validTo: string | undefined;
  version: number;
}

async function getSettingVersions(id: string): Promise<SettingVersion[]> {
  return store
    .query()
    .from("Setting", "s")
    .temporal("includeEnded")
    .whereNode("s", (s) => s.id.eq(id))
    .orderBy((ctx) => ctx.s.validFrom, "desc")
    .select((ctx) => ({
      props: ctx.s,
      validFrom: ctx.s.validFrom,
      validTo: ctx.s.validTo,
      version: ctx.s.version,
    }))
    .execute();
}
```

### Compare Versions

```typescript
interface VersionDiff {
  field: string;
  before: unknown;
  after: unknown;
}

async function compareVersions(
  id: string,
  version1: number,
  version2: number
): Promise<VersionDiff[]> {
  const versions = await store
    .query()
    .from("Setting", "s")
    .temporal("includeEnded")
    .whereNode("s", (s) => s.id.eq(id).and(s.version.in([version1, version2])))
    .orderBy((ctx) => ctx.s.version, "asc")
    .select((ctx) => ctx.s)
    .execute();

  if (versions.length !== 2) {
    throw new Error("Versions not found");
  }

  const [before, after] = versions;
  const diffs: VersionDiff[] = [];

  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const beforeVal = before[key as keyof typeof before];
    const afterVal = after[key as keyof typeof after];

    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      diffs.push({ field: key, before: beforeVal, after: afterVal });
    }
  }

  return diffs;
}
```

## Session Management

### Start Session

```typescript
async function startSession(
  userId: string,
  metadata: { ipAddress?: string; userAgent?: string }
): Promise<Node<typeof Session>> {
  return store.transaction(async (tx) => {
    const session = await tx.nodes.Session.create({
      startedAt: new Date().toISOString(),
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
    });

    const user = await tx.nodes.User.getById(userId);
    if (!user) throw new Error(`User not found: ${userId}`);
    await tx.edges.hasSession.create(user, session, {});

    return session;
  });
}
```

### End Session

```typescript
async function endSession(sessionId: string): Promise<void> {
  await store.nodes.Session.update(sessionId, {
    endedAt: new Date().toISOString(),
  });
}
```

### Get Session Activity

```typescript
async function getSessionActivity(
  sessionId: string
): Promise<Array<{ timestamp: string; action: string; entityType: string }>> {
  return store
    .query()
    .from("Session", "s")
    .whereNode("s", (s) => s.id.eq(sessionId))
    .traverse("inSession", "e", { direction: "in" })
    .to("AuditEntry", "a")
    .orderBy((ctx) => ctx.a.timestamp, "asc")
    .select((ctx) => ({
      timestamp: ctx.a.timestamp,
      action: ctx.a.action,
      entityType: ctx.a.entityType,
    }))
    .execute();
}
```

## Compliance Queries

### Who Changed This?

```typescript
async function whoChanged(
  entityType: string,
  entityId: string,
  field: string
): Promise<Array<{ user: string; timestamp: string; before: unknown; after: unknown }>> {
  const entries = await store
    .query()
    .from("AuditEntry", "a")
    .whereNode("a", (a) =>
      a.entityType.eq(entityType).and(a.entityId.eq(entityId))
    )
    .traverse("performedBy", "e")
    .to("User", "u")
    .orderBy((ctx) => ctx.a.timestamp, "desc")
    .select((ctx) => ({
      changes: ctx.a.changes,
      user: ctx.u.name,
      timestamp: ctx.a.timestamp,
    }))
    .execute();

  return entries
    .filter((e) => e.changes && field in e.changes)
    .map((e) => ({
      user: e.user,
      timestamp: e.timestamp,
      before: e.changes![field].before,
      after: e.changes![field].after,
    }));
}
```

### When Was This Value Set?

```typescript
async function whenWasValueSet(
  entityType: string,
  entityId: string,
  field: string,
  value: unknown
): Promise<{ timestamp: string; user: string } | undefined> {
  const entries = await store
    .query()
    .from("AuditEntry", "a")
    .whereNode("a", (a) =>
      a.entityType.eq(entityType).and(a.entityId.eq(entityId))
    )
    .traverse("performedBy", "e")
    .to("User", "u")
    .orderBy((ctx) => ctx.a.timestamp, "asc")
    .select((ctx) => ({
      changes: ctx.a.changes,
      user: ctx.u.name,
      timestamp: ctx.a.timestamp,
    }))
    .execute();

  const entry = entries.find(
    (e) => e.changes && field in e.changes && e.changes[field].after === value
  );

  return entry ? { timestamp: entry.timestamp, user: entry.user } : undefined;
}
```

## Export Audit Logs

### Stream to External System

```typescript
async function* exportAuditLogs(
  since: Date,
  batchSize = 1000
): AsyncGenerator<AuditEntryProps[]> {
  const stream = store
    .query()
    .from("AuditEntry", "a")
    .whereNode("a", (a) => a.timestamp.gte(since.toISOString()))
    .traverse("performedBy", "e")
    .to("User", "u")
    .orderBy((ctx) => ctx.a.timestamp, "asc")
    .select((ctx) => ({
      ...ctx.a,
      performedBy: ctx.u.email,
    }))
    .stream({ batchSize });

  let batch: AuditEntryProps[] = [];

  for await (const entry of stream) {
    batch.push(entry);

    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield batch;
  }
}

// Usage
async function syncToExternalAuditSystem(since: Date): Promise<void> {
  for await (const batch of exportAuditLogs(since)) {
    await externalAuditApi.ingestBatch(batch);
  }
}
```

## Next Steps

- [Document Management](/examples/document-management) - CMS with semantic search
- [Product Catalog](/examples/product-catalog) - Categories, variants, inventory
- [Workflow Engine](/examples/workflow-engine) - State machines with approvals
