---
title: Graph Interchange
description: Import and export graph data for backups, migrations, and external integrations
---

TypeGraph provides a standardized interchange format for importing and exporting
graph data. Use it for:

- Backing up and restoring graph data
- Migrating data between environments
- Exchanging data with external systems

## Quick Start

```typescript
import { importGraph, exportGraph, GraphDataSchema } from "@nicia-ai/typegraph/interchange";

// Export your graph
const backup = await exportGraph(store);

// Import into another store
const result = await importGraph(targetStore, backup, {
  onConflict: "update",
  onUnknownProperty: "strip",
});

console.log(`Imported ${result.nodes.created} nodes, ${result.edges.created} edges`);
```

## Interchange Format

The interchange format is a JSON structure validated by Zod schemas. You can use
`GraphDataSchema` to validate data before import, or export the schema as JSON
Schema for API documentation.

```typescript
import { GraphDataSchema } from "@nicia-ai/typegraph/interchange";

// Validate incoming data
const validated = GraphDataSchema.parse(jsonData);

// Export as JSON Schema for API docs
import { toJSONSchema } from "zod";
const jsonSchema = toJSONSchema(GraphDataSchema);
```

### Format Structure

```typescript
interface GraphData {
  formatVersion: "2.0";
  exportedAt: string; // ISO datetime
  source: {
    type: "typegraph-export" | "external";
    // Additional source-specific fields
  };
  nodes: Array<{
    kind: string;
    id: string;
    properties: Record<string, unknown>;
    validFrom?: string | null;
    validTo?: string;
    meta?: {
      version?: number;
      createdAt?: string;
      updatedAt?: string;
    };
  }>;
  edges: Array<{
    kind: string;
    id: string;
    from: { kind: string; id: string };
    to: { kind: string; id: string };
    properties: Record<string, unknown>;
    validFrom?: string | null;
    validTo?: string;
    meta?: {
      createdAt?: string;
      updatedAt?: string;
    };
  }>;
  identity?: {
    profile: "typegraph-identity-v1";
    mode: "state" | "archival";
    assertions: Array<{
      id: string;
      relation: "same" | "different";
      a: { kind: string; id: string };
      b: { kind: string; id: string };
      validFrom: string;
      validTo?: string;
    }>;
  };
}
```

`validFrom` has three states: the key **absent** means it wasn't requested
(`includeTemporal: false`, the default) — import defaults it to the
import's own creation timestamp. An **explicit `null`** means the source
row is confirmed to have no lower bound (open-left validity) — import
preserves that instead of re-stamping it. A **string** is an explicit
value, carried through unchanged.

### Format Version Compatibility

Exports always write `formatVersion: "2.0"`. The read side — both
`importGraph`/`importGraphStream` and `GraphDataSchema.parse` — additionally
accepts `"1.0"`. A 1.0 document is structurally a valid 2.0 document: the only
2.0 change is the additive optional `identity` section, so pre-existing 1.0
exports validate and import unchanged. You never need to rewrite the version
field of an older backup; validation and import handle both.

## Exporting Data

Use `exportGraph` to serialize your graph data:

```typescript
import { exportGraph } from "@nicia-ai/typegraph/interchange";

// Export everything
const fullExport = await exportGraph(store);

// Export specific node kinds
const peopleOnly = await exportGraph(store, {
  nodeKinds: ["Person", "Organization"],
});

// Export specific edge kinds
const relationshipsOnly = await exportGraph(store, {
  edgeKinds: ["worksAt", "knows"],
});

// Include metadata (version, timestamps)
const withMeta = await exportGraph(store, {
  includeMeta: true,
});

// Include temporal fields (validFrom, validTo)
const withTemporal = await exportGraph(store, {
  includeTemporal: true,
});

// Include soft-deleted records
const withDeleted = await exportGraph(store, {
  includeDeleted: true,
});

// Identity-enabled graphs export current assertions by default.
// Include ended assertion history explicitly:
const archival = await exportGraph(store, {
  identityMode: "archival",
});

// A self-contained archive pairs archival identity with includeDeleted:
const selfContainedArchive = await exportGraph(store, {
  identityMode: "archival",
  includeDeleted: true,
});
```

**Archival identity and soft-deleted endpoints:** `identityMode: "archival"`
also exports *ended* assertions, and an ended assertion can reference an
endpoint that was later soft-deleted. A default export omits soft-deleted rows,
so such an archive is not self-contained on its own — import tolerates the
missing endpoints for ended rows, but the archived nodes are gone. When the
archive must stand alone (backup, cold storage), pair it with
`includeDeleted: true` so those endpoints travel with it.

### Export Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `nodeKinds` | `string[]` | all | Filter to specific node types |
| `edgeKinds` | `string[]` | all | Filter to specific edge types |
| `includeMeta` | `boolean` | `false` | Include version and timestamps |
| `includeTemporal` | `boolean` | `false` | Include validFrom/validTo fields |
| `includeDeleted` | `boolean` | `false` | Include soft-deleted records |
| `identityMode` | `"state" \| "archival"` | `"state"` | Export current identity assertions, or current plus ended assertions |

**Round-trip caveat:** with the default `includeTemporal: false`, exported
records carry no `validFrom`/`validTo`. On import, an omitted `validFrom`
defaults to the *import's own* creation timestamp — so a plain
`exportGraph` + `importGraph` round trip does **not** reproduce the
source's original valid-time window; every imported record becomes valid
from import time forward. Pass `includeTemporal: true` on export when the
clone needs to match the source's `asOf` behavior exactly (this is what
`branch()` does internally).

## Importing Data

Use `importGraph` to load data into a store:

```typescript
import { importGraph } from "@nicia-ai/typegraph/interchange";

const result = await importGraph(store, data, {
  onConflict: "update",
  onUnknownProperty: "strip",
  validateReferences: true,
  batchSize: 1000,
});

if (result.success) {
  console.log(`Created: ${result.nodes.created} nodes, ${result.edges.created} edges`);
  console.log(`Updated: ${result.nodes.updated} nodes, ${result.edges.updated} edges`);
  console.log(`Skipped: ${result.nodes.skipped} nodes, ${result.edges.skipped} edges`);
} else {
  console.error("Import had errors:", result.errors);
}
```

### Import Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onConflict` | `"skip" \| "update" \| "error"` | required | How to handle existing entities |
| `onUnknownProperty` | `"error" \| "strip" \| "allow"` | `"error"` | How to handle extra properties |
| `validateReferences` | `boolean` | `true` | Verify edge endpoints exist |
| `batchSize` | `number` | `1000` | Batch size for database operations. Each batch pays fixed per-round-trip costs, so undersized batches slow client/server imports; inserts are still split by the driver bind budget internally. |

### Trusted initial import

`trustedImportGraph` and `trustedImportGraphStream` are a separate,
intentionally trusted path for loading a fresh dedicated database. They do not
turn off validation on `importGraph`; they bypass the normal store write
pipeline entirely.

```typescript
import {
  trustedImportGraphStream,
  type GraphInterchangeChunk,
} from "@nicia-ai/typegraph/interchange";

async function* chunks(): AsyncIterable<GraphInterchangeChunk> {
  yield { type: "header", header };
  for await (const nodes of readNodeBatches()) {
    yield { type: "nodes", nodes };
  }
  for await (const edges of readEdgeBatches()) {
    yield { type: "edges", edges };
  }
}

const result = await trustedImportGraphStream(store, chunks());
console.log(result); // { nodes: 1000000, edges: 5000000 }
```

The contract is deliberately narrow:

- The TypeGraph node and edge tables must be globally empty. A different graph
  in the same database also makes the database non-empty.
- The caller guarantees property shapes, endpoint existence, edge endpoint
  types, cardinality, and duplicate-free IDs. Only stream ordering and known
  kind names are checked.
- Recorded-time history, revision tracking, node uniqueness constraints,
  `searchable()` fields, and `embedding()` fields are rejected in this first
  version because their sidecar writes would otherwise be skipped.
- Nodes must precede edges. The `meta` timestamps and node version in an
  interchange row are not restored; the import creates new storage metadata.
- The complete stream is one transaction. Data insertion, temporary secondary
  index removal, index rebuilding, and planner statistics either all commit or
  all roll back.

Supported native paths are synchronous prepared-statement SQLite
(`better-sqlite3` and Bun SQLite) and transaction-capable PostgreSQL adapters
with raw execution support (including node-postgres, postgres.js, and PGlite).
Remote libSQL/Turso, D1, and HTTP-only PostgreSQL adapters reject the call with
`TrustedImportError` and `details.reason === "backend_unsupported"`.

Use `importGraph`/`importGraphStream` for external or uncertain data, conflict
handling, incremental loads, and any graph with the unsupported features above.
Use collection `bulkInsert` when the data is trusted but the database is not a
fresh dedicated target.

### Conflict Strategies

**`skip`** - Keep existing data, ignore incoming:

```typescript
// Useful for incremental imports where you don't want to overwrite
await importGraph(store, data, { onConflict: "skip" });
```

**`update`** - Merge incoming data into existing:

```typescript
// Useful for syncing updates from an external source
await importGraph(store, data, { onConflict: "update" });
```

**`error`** - Fail if any entity already exists:

```typescript
// Useful for initial imports where duplicates indicate a problem
await importGraph(store, data, { onConflict: "error" });
```

### Unknown Property Handling

When importing data that has properties not defined in your schema:

**`error`** - Reject the import (default, safest):

```typescript
await importGraph(store, data, { onUnknownProperty: "error" });
// Throws if data has { name: "Alice", unknownField: "value" }
```

**`strip`** - Remove unknown properties silently:

```typescript
await importGraph(store, data, { onUnknownProperty: "strip" });
// { name: "Alice", unknownField: "value" } becomes { name: "Alice" }
```

**`allow`** - Pass through to storage:

```typescript
await importGraph(store, data, { onUnknownProperty: "allow" });
// Behavior depends on your database and schema strictness
```

## Backup and Restore

### Creating Backups

```typescript
import { exportGraph } from "@nicia-ai/typegraph/interchange";
import fs from "fs/promises";

async function createBackup(store: Store, backupDir: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `backup-${timestamp}.json`;

  const data = await exportGraph(store, {
    includeMeta: true,
    includeTemporal: true,
  });

  await fs.writeFile(
    `${backupDir}/${filename}`,
    JSON.stringify(data, null, 2)
  );

  return filename;
}
```

### Restoring from Backup

```typescript
import { importGraph, GraphDataSchema } from "@nicia-ai/typegraph/interchange";
import fs from "fs/promises";

async function restoreBackup(store: Store, backupPath: string) {
  const json = await fs.readFile(backupPath, "utf-8");
  const data = GraphDataSchema.parse(JSON.parse(json));

  const result = await importGraph(store, data, {
    onConflict: "update", // or "error" for clean restore
    onUnknownProperty: "error",
  });

  if (!result.success) {
    throw new Error(`Restore failed: ${result.errors.map(e => e.error).join(", ")}`);
  }

  return result;
}
```

## Migration Between Environments

Move data from development to staging, or staging to production:

```typescript
import { createStore } from "@nicia-ai/typegraph";
import { exportGraph, importGraph } from "@nicia-ai/typegraph/interchange";
import { graph } from "./schema";

async function migrateData(
  sourceBackend: GraphBackend,
  targetBackend: GraphBackend,
) {
  const sourceStore = createStore(graph, sourceBackend);
  const targetStore = createStore(graph, targetBackend);

  // Export from source
  const data = await exportGraph(sourceStore);

  // Import to target
  const result = await importGraph(targetStore, data, {
    onConflict: "error", // Ensure clean migration
    onUnknownProperty: "error",
    validateReferences: true,
  });

  return result;
}
```

## Building Custom Import Pipelines

For complex import scenarios, you can build pipelines using the Zod schemas:

```typescript
import {
  GraphDataSchema,
  InterchangeNodeSchema,
  InterchangeEdgeSchema,
  type GraphData,
} from "@nicia-ai/typegraph/interchange";

// Transform external data to interchange format
function transformExternalData(externalRecords: ExternalRecord[]): GraphData {
  const nodes = externalRecords.map((record) => ({
    kind: "Document",
    id: record.externalId,
    properties: {
      title: record.name,
      content: record.body,
      source: { system: "external", id: record.externalId },
    },
  }));

  // Validate each node
  const validatedNodes = nodes.map((node) => InterchangeNodeSchema.parse(node));

  return {
    formatVersion: "2.0",
    exportedAt: new Date().toISOString(),
    source: {
      type: "external",
      description: "Imported from external CMS",
    },
    nodes: validatedNodes,
    edges: [],
  };
}
```

## Error Handling

Import returns detailed error information for partial failures:

```typescript
const result = await importGraph(store, data, { onConflict: "error" });

if (!result.success) {
  for (const error of result.errors) {
    console.error(
      `Failed to import ${error.entityType} ${error.kind}:${error.id}: ${error.error}`
    );
  }

  // Decide how to handle partial import
  if (result.nodes.created > 0 || result.edges.created > 0) {
    console.log("Partial import completed, some entities were created");
  }
}
```

## Best Practices

### Validate Before Import

Always validate external data before importing:

```typescript
import { GraphDataSchema } from "@nicia-ai/typegraph/interchange";

const result = GraphDataSchema.safeParse(untrustedData);
if (!result.success) {
  console.error("Invalid data:", result.error.format());
  return;
}

await importGraph(store, result.data, options);
```

### Use Transactions for Consistency

Import operations use transactions when the backend supports them. For backends
without transaction support, consider smaller batch sizes to minimize partial
failure impact.

### Test with `onConflict: "error"` First

When setting up a new import pipeline, use `onConflict: "error"` to catch
unexpected duplicates early:

```typescript
// Development/testing
await importGraph(store, data, { onConflict: "error" });

// Production (after validation)
await importGraph(store, data, { onConflict: "update" });
```

### Monitor Import Results

Log import statistics for observability:

```typescript
const result = await importGraph(store, data, options);

logger.info("Import completed", {
  success: result.success,
  nodesCreated: result.nodes.created,
  nodesUpdated: result.nodes.updated,
  nodesSkipped: result.nodes.skipped,
  edgesCreated: result.edges.created,
  edgesUpdated: result.edges.updated,
  edgesSkipped: result.edges.skipped,
  errorCount: result.errors.length,
});
```

## Next Steps

- [Data Sync](/data-sync) - Patterns for keeping external data in sync
- [Schema Migrations](/schema-management) - Managing schema changes over time
- [Integration Patterns](/integration) - Database setup and deployment
