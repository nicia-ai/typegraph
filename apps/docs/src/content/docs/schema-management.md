---
title: Schema Migrations
description: Schema versioning, migration, and lifecycle management
---

## When Do You Need Schema Management?

As your application evolves, your graph schema changes:

- **Adding features**: New node types, new properties, new relationships
- **Refactoring**: Renaming types, changing property formats
- **Deploying safely**: Ensuring schema changes don't break running applications

Without schema management, you'd face:

- No way to know if the database matches your code
- Silent failures when property names change
- Manual migration scripts for every deployment

TypeGraph's schema management:

1. **Stores the schema in the database** alongside your data
2. **Detects changes** between your code and the stored schema
3. **Auto-migrates safe changes** (adding types, optional properties)
4. **Blocks breaking changes** until you handle them explicitly

## How It Works

TypeGraph stores your graph schema in the database, enabling version tracking,
safe migrations, and runtime introspection.

When you create a store with `createStoreWithSchema()`, TypeGraph:

1. Serializes your graph definition to JSON
2. Compares it with the stored schema (if any)
3. Returns the result so you can act on it

## Schema Lifecycle

When you create a store, TypeGraph can automatically manage schema versions:

```typescript
import { createStoreWithSchema } from "@nicia-ai/typegraph";

const [store, result] = await createStoreWithSchema(graph, backend);

switch (result.status) {
  case "initialized":
    console.log(`Schema initialized at version ${result.version}`);
    break;
  case "unchanged":
    console.log(`Schema unchanged at version ${result.version}`);
    break;
  case "migrated":
    console.log(`Migrated from v${result.fromVersion} to v${result.toVersion}`);
    break;
  case "breaking":
    console.log("Breaking changes detected:", result.actions);
    break;
}
```

## Basic vs Managed Store

TypeGraph provides two ways to create a store:

### Basic Store (No Schema Management)

Use `createStore()` when you manage schema versions yourself:

```typescript
import { createStore } from "@nicia-ai/typegraph";

const store = createStore(graph, backend);
// No schema versioning - you handle migrations manually
```

### Managed Store (Automatic Schema Management)

Use `createStoreWithSchema()` for automatic version tracking:

```typescript
import { createStoreWithSchema } from "@nicia-ai/typegraph";

const [store, result] = await createStoreWithSchema(graph, backend, {
  autoMigrate: true, // Auto-apply safe changes (default: true)
  throwOnBreaking: true, // Throw on breaking changes (default: true)
});
```

## Schema Validation Results

The validation result indicates what happened during store initialization:

| Status        | Meaning                                        |
| ------------- | ---------------------------------------------- |
| `initialized` | First run - schema version 1 was created       |
| `unchanged`   | Schema matches stored version - no changes     |
| `migrated`    | Safe changes auto-applied, new version created |
| `breaking`    | Breaking changes detected, action required     |

## Safe vs Breaking Changes

### Safe Changes (Auto-Migrated)

These changes are backwards compatible and can be auto-migrated:

- Adding new node types
- Adding new edge types
- Adding optional properties with defaults
- Adding new ontology relations

### Breaking Changes (Require Manual Action)

These changes require manual migration:

- Removing node or edge types
- Renaming node or edge types
- Changing property types
- Removing properties
- Changing cardinality constraints to be more restrictive

## Handling Breaking Changes

When breaking changes are detected:

```typescript
const [store, result] = await createStoreWithSchema(graph, backend, {
  throwOnBreaking: false, // Don't throw, inspect instead
});

if (result.status === "breaking") {
  console.log("Breaking changes detected:");
  console.log("Summary:", result.diff.summary);
  console.log("Required actions:");
  for (const action of result.actions) {
    console.log(`  - ${action}`);
  }

  // Option 1: Fix your schema to be backwards compatible

  // Option 2: Force migration (data loss possible!)
  // await migrateSchema(backend, graph, currentVersion);
}
```

## Schema Introspection

Query the stored schema at runtime:

```typescript
import { getActiveSchema, isSchemaInitialized, getSchemaChanges } from "@nicia-ai/typegraph";

// Check if schema exists
const initialized = await isSchemaInitialized(backend, "my_graph");

// Get the current schema
const schema = await getActiveSchema(backend, "my_graph");
if (schema) {
  console.log("Graph ID:", schema.graphId);
  console.log("Version:", schema.version);
  console.log("Nodes:", Object.keys(schema.nodes));
  console.log("Edges:", Object.keys(schema.edges));
}

// Preview changes without applying
const diff = await getSchemaChanges(backend, graph);
if (diff?.hasChanges) {
  console.log("Pending changes:", diff.summary);
  console.log("Is backwards compatible:", diff.isBackwardsCompatible);
}
```

## Manual Migration

For full control over migrations:

```typescript
import { initializeSchema, migrateSchema, ensureSchema } from "@nicia-ai/typegraph";

// Initialize schema (first run only)
const row = await initializeSchema(backend, graph);
console.log("Created version:", row.version);

// Migrate to new version
const newVersion = await migrateSchema(backend, graph, currentVersion);
console.log("Migrated to version:", newVersion);

// Or use ensureSchema for automatic handling
const result = await ensureSchema(backend, graph, {
  autoMigrate: true,
  throwOnBreaking: true,
});
```

## Schema Serialization

Schemas are stored as JSON documents with computed hashes for fast comparison:

```typescript
import { serializeSchema, computeSchemaHash } from "@nicia-ai/typegraph";

// Serialize a graph definition
const serialized = serializeSchema(graph, 1);

// Compute hash for comparison
const hash = computeSchemaHash(serialized);
```

The serialized schema includes:

- Graph ID and version
- All node types with their Zod schemas (as JSON Schema)
- All edge types with endpoints and constraints
- Complete ontology relations
- Uniqueness constraints and delete behaviors

## Version History

TypeGraph maintains a history of all schema versions:

```text
typegraph_schema_versions
├── version 1 (initial)
├── version 2 (added User node)
├── version 3 (added email property) ← active
└── ...
```

Only one version is marked as "active" at a time. Previous versions are
preserved for auditing and potential rollback.

## Best Practices

### 1. Use Managed Stores in Production

```typescript
// Production: Use schema management
const [store, result] = await createStoreWithSchema(graph, backend);

// Development: Basic store is fine for rapid iteration
const store = createStore(graph, backend);
```

### 2. Check Migration Status on Startup

```typescript
async function initializeApp() {
  const [store, result] = await createStoreWithSchema(graph, backend);

  if (result.status === "breaking") {
    console.error("Database schema incompatible with application!");
    console.error("Run migrations before deploying this version.");
    process.exit(1);
  }

  if (result.status === "migrated") {
    console.log(`Schema auto-migrated to v${result.toVersion}`);
  }

  return store;
}
```

### 3. Preview Changes Before Deployment

```typescript
// In your CI/CD pipeline or migration script
const diff = await getSchemaChanges(backend, graph);

if (diff?.hasChanges) {
  console.log("Schema changes detected:");
  console.log(diff.summary);

  if (!diff.isBackwardsCompatible) {
    console.error("Breaking changes require manual migration!");
    process.exit(1);
  }
}
```

### 4. Add Properties with Defaults

When adding new properties, always provide defaults to ensure backwards
compatibility:

```typescript
// Good: Optional with default
const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
    // New property with default - safe migration
    status: z.enum(["active", "inactive"]).default("active"),
  }),
});

// Bad: Required without default - breaking change
const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
    status: z.enum(["active", "inactive"]), // No default!
  }),
});
```
