---
title: Schema Migrations
description: Schema versioning, migration, and lifecycle management
---

For a practical guide on evolving schemas across deployments, see
[Evolving Schemas in Production](/schema-evolution).

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

1. Creates the base tables if the database is fresh (auto-bootstrap)
2. Serializes your graph definition to JSON
3. Compares it with the stored schema (if any)
4. Returns the result so you can act on it

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
  case "pending":
    console.log(`Safe changes pending at version ${result.version}`);
    break;
  case "breaking":
    console.log("Breaking changes detected:", result.actions);
    break;
}
```

## Basic vs Managed vs Verified Store

TypeGraph provides three ways to create a store, each suited to a
different deployment role:

### Basic Store (No Schema Management)

Use `createStore()` when you manage schema versions yourself:

```typescript
import { createStore } from "@nicia-ai/typegraph";

const store = createStore(graph, backend);
// No schema versioning - you handle migrations manually
```

:::caution[Fulltext requires the managed store]
`createStore()` is attach-only. If the graph has `searchable()` fields,
use `createStoreWithSchema()` (below) at boot — it durably materializes
the fulltext storage. Bare `createStore()` throws
`StoreNotInitializedError` on the first fulltext operation.
:::

### Managed Store (Automatic Schema Management)

Use `createStoreWithSchema()` for automatic version tracking:

```typescript
import { createStoreWithSchema } from "@nicia-ai/typegraph";

const [store, result] = await createStoreWithSchema(graph, backend, {
  autoMigrate: true, // Auto-apply safe changes (default: true)
  throwOnBreaking: true, // Throw on breaking changes (default: true)
  onBeforeMigrate: (context) => {
    console.log(`Migrating ${context.graphId} from v${context.fromVersion} to v${context.toVersion}`);
  },
  onAfterMigrate: (context) => {
    console.log(`Migration complete: v${context.toVersion}`);
  },
});
```

### Verified Store (Zero-DDL Attach With Verification Gate)

Use `createVerifiedStore()` at runtime when the application runs under a
least-privilege, DML-only database role and a separate privileged step
has already advanced the schema. It is the runtime counterpart of
`createStoreWithSchema()`: a synchronous-semantics attach that **issues
no DDL** and fails fast if the database is not at the same schema
version as the code graph.

```typescript
import { createVerifiedStore } from "@nicia-ai/typegraph";

// Runtime — least-privilege, DML-only role. Zero DDL.
const [store, result] = await createVerifiedStore(graph, backend);
// result.status === "unchanged" on success.
```

It throws:

- `ConfigurationError` if no schema has been initialized (run the
  privileged migration step first).
- `MigrationError` if the persisted schema is behind the code graph by
  **any** pending change (safe or breaking) — the least-privilege
  runtime cannot migrate.
- `StoreNotInitializedError` if the schema is current but the
  runtime-contribution markers (e.g. fulltext) are missing/stale.

If you only need the check without building a Store (e.g. a readiness
probe), call `assertSchemaCurrent(backend, graph)` directly — it returns
the same `SchemaValidationResult` or throws the same errors.

:::note[Database privileges]
Only `createStoreWithSchema()` runs DDL. `createStore()` is a
synchronous zero-I/O attach; `createVerifiedStore()` is a SELECT-only
attach (zero DDL — reads the active schema row and contribution
markers, nothing else). To run the application under a least-privilege,
DML-only role, do the privileged migration step once with
`createStoreWithSchema(graph, adminBackend)` and use
`createVerifiedStore()` at runtime. See
[Database roles & least privilege](/backend-setup#database-roles--least-privilege)
for the canonical breakdown.
:::

## Schema Validation Results

The validation result indicates what happened during store initialization:

| Status        | Meaning                                            |
| ------------- | -------------------------------------------------- |
| `initialized` | First run - schema version 1 was created           |
| `unchanged`   | Schema matches stored version - no changes         |
| `migrated`    | Safe changes auto-applied, new version created     |
| `pending`     | Safe changes detected but `autoMigrate` is `false` |
| `breaking`    | Breaking changes detected, action required         |

The `initialized` and `migrated` results also include
`committedRow: SchemaVersionRow`, the schema row that was just written. Most
applications only need the version fields shown above, but integrations that
build schema metadata can use `committedRow` without issuing another
`getActiveSchema` read.

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
  // import { migrateSchema } from "@nicia-ai/typegraph/schema";
  // await migrateSchema(backend, graph, currentVersion);
}
```

## Schema Introspection

Query the stored schema at runtime:

```typescript
import { getActiveSchema, isSchemaInitialized, getSchemaChanges } from "@nicia-ai/typegraph/schema";

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
  console.log("Is backwards compatible:", !diff.hasBreakingChanges);
}
```

## Manual Migration

For full control over migrations:

```typescript
import { initializeSchema, migrateSchema, rollbackSchema, ensureSchema } from "@nicia-ai/typegraph/schema";

// Initialize schema (first run only)
const row = await initializeSchema(backend, graph);
console.log("Created version:", row.version);

// Migrate to new version
const newVersion = await migrateSchema(backend, graph, currentVersion);
console.log("Migrated to version:", newVersion);

// Rollback to a previous version
await rollbackSchema(backend, "my_graph", 1);
console.log("Rolled back to version 1");

// Or use ensureSchema for automatic handling
const result = await ensureSchema(backend, graph, {
  autoMigrate: true,
  throwOnBreaking: true,
});
```

## Migrating Legacy Embedding Storage

Embeddings now live in per-`(graphId, kind, field)` typed tables
(`tg_vec_<graphId>_<kind>_<field>`), provisioned by `createStoreWithSchema` (the
privileged migrator) at boot. This replaces the single shared
`typegraph_node_embeddings` table. New deployments need no action — the per-field
tables are materialized by `createStoreWithSchema`, which the legacy migration
below also relies on having run.

Deployments that already hold rows in the legacy table run a one-time, idempotent
cutover with `migrateLegacyEmbeddings()`, exported from the package root:

```typescript
import { migrateLegacyEmbeddings } from "@nicia-ai/typegraph";

// `backend` is the post-cutover backend, wired with its VectorStrategy.
const result = await migrateLegacyEmbeddings({ backend });

console.log("Rows migrated:", result.migrated);
console.log("Per field:", result.perField);
console.log("Skipped (dimension mismatch):", result.skippedDimensionMismatch);
console.log("Legacy table existed:", result.legacyTablePresent);
```

The run re-inserts every legacy embedding into per-field storage and is a clean
no-op on a fresh install or a re-run (`legacyTablePresent: false`). A non-empty
`skippedDimensionMismatch` flags `(kind, field)` slots that held mixed dimensions
and need a deliberate re-embed at a single dimension — see
[`reembedVectorField`](/schema-evolution#changing-an-embedding-dimension).

The vector and hybrid query API (`.similarTo()`, `store.search.vector`,
`store.search.hybrid`) is storage-transparent and unchanged by this cutover.

## Schema Serialization

Schemas are stored as JSON documents with computed hashes for fast comparison:

```typescript
import { serializeSchema, computeSchemaHash } from "@nicia-ai/typegraph/schema";

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
import { getSchemaChanges } from "@nicia-ai/typegraph/schema";

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
