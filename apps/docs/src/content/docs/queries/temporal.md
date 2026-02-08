---
title: Temporal
description: Time-based queries with temporal()
---

TypeGraph tracks temporal validity for all nodes and edges. Use temporal queries to view the graph
at a point in time, audit changes, or access historical data.

## Temporal Modes

The `temporal()` method controls which versions of data are returned:

| Mode | Description |
|------|-------------|
| `"current"` | Only currently valid data (default behavior) |
| `"asOf"` | Data as it existed at a specific timestamp |
| `"includeEnded"` | All versions, including historical |
| `"includeTombstones"` | All versions, including soft-deleted |

## Current State (Default)

By default, queries return only currently valid, non-deleted data:

```typescript
// Returns only current, non-deleted nodes
const currentPeople = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ctx.p)
  .execute();
```

This is equivalent to:

```typescript
.temporal("current")
```

## Point-in-Time Queries (asOf)

Query the graph as it existed at a specific moment:

```typescript
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const pastState = await store
  .query()
  .from("Article", "a")
  .temporal("asOf", yesterday)
  .whereNode("a", (a) => a.id.eq(articleId))
  .select((ctx) => ctx.a)
  .execute();
```

This returns nodes and edges that were valid at the specified timestamp, even if they've since been updated or deleted.

### Use Cases for asOf

- **Auditing**: See what data looked like at a specific time
- **Debugging**: Reproduce issues by querying historical state
- **Compliance**: Generate point-in-time reports
- **Recovery**: Find old values before an erroneous update

```typescript
// What did the user's profile look like last week?
const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const historicalProfile = await store
  .query()
  .from("User", "u")
  .temporal("asOf", lastWeek)
  .whereNode("u", (u) => u.id.eq(userId))
  .select((ctx) => ctx.u)
  .first();
```

## Including Historical Data (includeEnded)

View all versions, including superseded records:

```typescript
const history = await store
  .query()
  .from("Article", "a")
  .temporal("includeEnded")
  .whereNode("a", (a) => a.id.eq(articleId))
  .orderBy((ctx) => ctx.a.validFrom, "desc")
  .select((ctx) => ({
    title: ctx.a.title,
    validFrom: ctx.a.validFrom,
    validTo: ctx.a.validTo,
    version: ctx.a.version,
  }))
  .execute();

// Result shows all versions:
// [
//   { title: "Final Title", validFrom: "2024-03-01", validTo: undefined, version: 3 },
//   { title: "Draft v2", validFrom: "2024-02-15", validTo: "2024-03-01", version: 2 },
//   { title: "Initial Draft", validFrom: "2024-02-01", validTo: "2024-02-15", version: 1 },
// ]
```

### Audit Trail

Build a complete change history:

```typescript
async function getAuditTrail(nodeId: string) {
  return store
    .query()
    .from("Document", "d")
    .temporal("includeEnded")
    .whereNode("d", (d) => d.id.eq(nodeId))
    .select((ctx) => ({
      version: ctx.d.version,
      title: ctx.d.title,
      status: ctx.d.status,
      validFrom: ctx.d.validFrom,
      validTo: ctx.d.validTo,
      updatedAt: ctx.d.updatedAt,
    }))
    .orderBy("d", "version", "asc")
    .execute();
}
```

## Including Soft-Deleted Data (includeTombstones)

Include records that have been soft-deleted:

```typescript
const allIncludingDeleted = await store
  .query()
  .from("User", "u")
  .temporal("includeTombstones")
  .select((ctx) => ({
    id: ctx.u.id,
    name: ctx.u.name,
    deletedAt: ctx.u.deletedAt,  // Will have a value for deleted records
  }))
  .execute();
```

### Filtering Deleted Records

```typescript
// Find only deleted records
const deletedUsers = await store
  .query()
  .from("User", "u")
  .temporal("includeTombstones")
  .whereNode("u", (u) => u.deletedAt.isNotNull())
  .select((ctx) => ({
    id: ctx.u.id,
    name: ctx.u.name,
    deletedAt: ctx.u.deletedAt,
  }))
  .execute();
```

## Temporal Metadata Fields

When querying with temporal context, these fields are available:

| Field | Type | Description |
|-------|------|-------------|
| `validFrom` | `string \| undefined` | When this version became valid |
| `validTo` | `string \| undefined` | When this version was superseded (undefined if current) |
| `createdAt` | `string` | When the node was first created |
| `updatedAt` | `string` | When this version was written |
| `deletedAt` | `string \| undefined` | Soft-delete timestamp (undefined if not deleted) |
| `version` | `number` | Optimistic concurrency version number |

```typescript
.select((ctx) => ({
  ...ctx.a,                     // All node properties
  validFrom: ctx.a.validFrom,
  validTo: ctx.a.validTo,
  createdAt: ctx.a.createdAt,
  updatedAt: ctx.a.updatedAt,
  deletedAt: ctx.a.deletedAt,
  version: ctx.a.version,
}))
```

## Temporal Traversals

Temporal modes apply to traversals as well:

```typescript
// See who worked at a company last year
const lastYear = new Date("2023-01-01").toISOString();

const pastEmployees = await store
  .query()
  .from("Company", "c")
  .temporal("asOf", lastYear)
  .whereNode("c", (c) => c.name.eq("Acme Corp"))
  .traverse("worksAt", "e", { direction: "in" })
  .to("Person", "p")
  .select((ctx) => ({
    name: ctx.p.name,
    role: ctx.e.role,
  }))
  .execute();
```

## Real-World Examples

### Version Comparison

Compare two versions of a document:

```typescript
async function compareVersions(docId: string, v1: number, v2: number) {
  const versions = await store
    .query()
    .from("Document", "d")
    .temporal("includeEnded")
    .whereNode("d", (d) => d.id.eq(docId))
    .select((ctx) => ctx.d)
    .execute();

  const version1 = versions.find((v) => v.version === v1);
  const version2 = versions.find((v) => v.version === v2);

  return { version1, version2 };
}
```

### Compliance Reporting

Generate a report as of a specific date:

```typescript
async function generateQuarterlyReport(quarterEnd: string) {
  const activeContracts = await store
    .query()
    .from("Contract", "c")
    .temporal("asOf", quarterEnd)
    .whereNode("c", (c) => c.status.eq("active"))
    .traverse("belongsTo", "e")
    .to("Customer", "cust")
    .select((ctx) => ({
      contractId: ctx.c.id,
      value: ctx.c.value,
      customer: ctx.cust.name,
    }))
    .execute();

  return {
    asOf: quarterEnd,
    totalContracts: activeContracts.length,
    totalValue: activeContracts.reduce((sum, c) => sum + c.value, 0),
    contracts: activeContracts,
  };
}
```

### Undo/Recovery

Find the previous value before an update:

```typescript
async function getPreviousVersion(nodeId: string) {
  const versions = await store
    .query()
    .from("Document", "d")
    .temporal("includeEnded")
    .whereNode("d", (d) => d.id.eq(nodeId))
    .select((ctx) => ctx.d)
    .orderBy("d", "version", "desc")
    .limit(2)
    .execute();

  return {
    current: versions[0],
    previous: versions[1],
  };
}
```

## Next Steps

- [Filter](/queries/filter) - Filtering with predicates
- [Traverse](/queries/traverse) - Graph traversals
- [Execute](/queries/execute) - Running queries
