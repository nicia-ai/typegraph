---
title: Graph Interchange
description: Import and export graph data for backups, migrations, and external integrations
---

TypeGraph provides a standardized interchange format for importing and exporting
graph data. Use it for:

- Importing data extracted by TypeGraph Cloud
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
  formatVersion: "1.0";
  exportedAt: string; // ISO datetime
  source: {
    type: "typegraph-cloud" | "typegraph-export" | "external";
    // Additional source-specific fields
  };
  nodes: Array<{
    kind: string;
    id: string;
    properties: Record<string, unknown>;
    validFrom?: string;
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
    validFrom?: string;
    validTo?: string;
    meta?: {
      createdAt?: string;
      updatedAt?: string;
    };
  }>;
}
```

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
```

### Export Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `nodeKinds` | `string[]` | all | Filter to specific node types |
| `edgeKinds` | `string[]` | all | Filter to specific edge types |
| `includeMeta` | `boolean` | `false` | Include version and timestamps |
| `includeTemporal` | `boolean` | `false` | Include validFrom/validTo fields |
| `includeDeleted` | `boolean` | `false` | Include soft-deleted records |

## Importing Data

Use `importGraph` to load data into a store:

```typescript
import { importGraph } from "@nicia-ai/typegraph/interchange";

const result = await importGraph(store, data, {
  onConflict: "update",
  onUnknownProperty: "strip",
  validateReferences: true,
  batchSize: 100,
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
| `batchSize` | `number` | `100` | Batch size for database operations |

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

## TypeGraph Cloud Integration

When using TypeGraph Cloud for document extraction, the workflow is:

1. **Schema Discovery** (optional): Cloud analyzes your documents and proposes schemas
2. **Schema-Guided Extraction**: Cloud extracts entities/relationships matching your schema
3. **Import**: Use `importGraph` to load extracted data into your store

```typescript
import { importGraph, GraphDataSchema } from "@nicia-ai/typegraph/interchange";

// Fetch extraction from Cloud API
const response = await fetch("https://api.typegraph.cloud/extractions/abc123", {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const cloudData = await response.json();

// Validate and import
const validated = GraphDataSchema.parse(cloudData);
const result = await importGraph(store, validated, {
  onConflict: "update",
  onUnknownProperty: "strip", // Cloud may include provenance fields
});
```

### Cloud Data Sources

Data from TypeGraph Cloud includes source metadata:

```typescript
{
  formatVersion: "1.0",
  exportedAt: "2024-01-15T10:30:00Z",
  source: {
    type: "typegraph-cloud",
    extractionId: "ext_abc123",
    schemaId: "schema_xyz789",
    schemaVersion: 2,
  },
  nodes: [...],
  edges: [...],
}
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
    formatVersion: "1.0",
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
