---
title: Evolving Schemas in Production
description: Step-by-step guide for safely evolving your graph schema across deployments
---

Your graph schema will change as your application grows. This guide covers how
to make those changes safely — from adding a field to renaming a node type.

For API reference, see [Schema Migrations](/schema-management).

## How Schema Evolution Works

When you call `createStoreWithSchema()`, TypeGraph:

1. Serializes your current graph definition
2. Compares it against the stored schema (by hash, then by diff)
3. **Safe changes** — auto-migrates and bumps the version
4. **Breaking changes** — throws `MigrationError` (or returns `status: "breaking"`)

The key insight: TypeGraph manages **schema metadata**, not data migration. When
you add an optional field, TypeGraph records that the schema now includes it. It
does not alter existing rows — Zod defaults handle that at read time.

## Safe Changes

These changes are backwards compatible and auto-migrate without intervention:

- Adding new node types
- Adding new edge types
- Adding optional properties (with defaults)
- Adding ontology relations

### Adding an Optional Property

```typescript
// Version 1
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
  }),
});

// Version 2 — safe, auto-migrates
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(),
  }),
});
```

On startup, `createStoreWithSchema()` returns `status: "migrated"`. Existing
Person nodes return `email: undefined` — no data transformation needed.

### Adding a Node Type with Edges

```typescript
// Version 2 — add Company and worksAt in one deploy
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

const graph = defineGraph({
  id: "my_app",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
  },
});
```

This is a single safe migration. New node and edge types don't affect existing
data.

## Breaking Changes

These require explicit handling:

- Removing node or edge types
- Removing properties
- Adding required properties (no default)
- Renaming types or properties

TypeGraph will throw `MigrationError` by default. You have two options: fix
the schema to be backwards compatible, or use the expand-contract pattern.

## The Expand-Contract Pattern

For breaking changes, use a multi-deploy strategy. This is the same pattern
used in relational database migrations — deploy in phases so there's never a
moment where running code is incompatible with the schema.

### Renaming a Property

Rename `name` to `fullName` on Person in three deploys:

#### Deploy 1 — Expand: add the new property

```typescript
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    fullName: z.string().optional(), // New property, optional for now
  }),
});
```

Safe migration. Then backfill existing data:

```typescript
const [store] = await createStoreWithSchema(graph, backend);

const people = await store.query(Person).execute();
for (const person of people) {
  if (!person.properties.fullName) {
    await store.nodes.Person.update(person.id, {
      fullName: person.properties.name,
    });
  }
}
```

#### Deploy 2 — Switch: use the new property everywhere

Update all application code to read/write `fullName` instead of `name`. Both
properties still exist, so this deploy is safe.

#### Deploy 3 — Contract: remove the old property

```typescript
const Person = defineNode("Person", {
  schema: z.object({
    fullName: z.string(),
  }),
});
```

This is a breaking change (removing `name`). Use `migrateSchema()` to force it:

```typescript
import { getSchemaChanges, migrateSchema } from "@nicia-ai/typegraph/schema";

const [store, result] = await createStoreWithSchema(graph, backend, {
  throwOnBreaking: false,
});

if (result.status === "breaking") {
  // We've already backfilled — safe to force migrate
  const activeSchema = await backend.getActiveSchema(graph.id);
  await migrateSchema(backend, graph, activeSchema!.version);
}
```

### Removing a Node Type

#### Deploy 1 — Stop creating new instances

Update application code to stop creating the deprecated node type. Existing data
remains.

#### Deploy 2 — Clean up references

Delete edges that reference the deprecated node type, then delete the nodes
themselves:

```typescript
// Delete all edges connected to deprecated nodes
const deprecated = await store.query(OldNode).execute();
for (const node of deprecated) {
  await store.nodes.OldNode.delete(node.id);
}
```

#### Deploy 3 — Remove from schema

Remove the node type from `defineGraph()` and force migrate.

### Changing a Property Type

Change `age` from `z.string()` to `z.number()`:

#### Deploy 1 — Add the new property

```typescript
const Person = defineNode("Person", {
  schema: z.object({
    age: z.string(),
    ageNumeric: z.number().optional(),
  }),
});
```

#### Deploy 2 — Backfill and switch

```typescript
const people = await store.query(Person).execute();
for (const person of people) {
  if (person.properties.ageNumeric === undefined) {
    await store.nodes.Person.update(person.id, {
      ageNumeric: parseInt(person.properties.age, 10),
    });
  }
}
```

#### Deploy 3 — Contract

Remove `age`, rename `ageNumeric` to `age` with the new type, and force migrate.

## Pre-Deploy Schema Checks

Use `getSchemaChanges()` in CI to catch breaking changes before they reach
production.

### CI/CD Script

```typescript
import { getSchemaChanges } from "@nicia-ai/typegraph/schema";

async function checkSchema(backend: GraphBackend, graph: GraphDef) {
  const diff = await getSchemaChanges(backend, graph);

  if (!diff) {
    console.log("No existing schema — first deploy");
    return;
  }

  if (!diff.hasChanges) {
    console.log("Schema unchanged");
    return;
  }

  console.log("Schema changes detected:");
  console.log(diff.summary);

  for (const change of [...diff.nodes, ...diff.edges]) {
    const icon =
      change.severity === "safe"
        ? "[safe]"
        : change.severity === "warning"
          ? "[warn]"
          : "[BREAKING]";
    console.log(`  ${icon} ${change.details}`);
  }

  if (diff.hasBreakingChanges) {
    console.error("Breaking changes require migration before deploy.");
    process.exit(1);
  }
}
```

### Staging Validation

Before deploying to production, run against a staging database that mirrors
production schema state:

```typescript
const [store, result] = await createStoreWithSchema(graph, stagingBackend);

switch (result.status) {
  case "initialized":
    console.log("Staging DB was empty — initialized");
    break;
  case "migrated":
    console.log(
      `Auto-migrated v${result.fromVersion} → v${result.toVersion}`,
    );
    console.log("Changes:", result.diff.summary);
    break;
  case "breaking":
    console.error("Would break in production. Fix before deploying.");
    process.exit(1);
    break;
}
```

## Testing Schema Changes

### Unit Testing Migrations

Test that your migration code handles existing data correctly:

```typescript
import { createStoreWithSchema, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { createTestBackend } from "./test-utils";

it("migrates name to fullName", async () => {
  const backend = createTestBackend();

  // Set up v1 with data
  const graphV1 = defineGraph({
    id: "test",
    nodes: { Person: { type: PersonV1 } },
    edges: {},
  });
  const [storeV1] = await createStoreWithSchema(graphV1, backend);
  await storeV1.nodes.Person.create({ name: "Alice" });

  // Migrate to v2 (expand phase)
  const graphV2 = defineGraph({
    id: "test",
    nodes: { Person: { type: PersonV2WithBothFields } },
    edges: {},
  });
  const [storeV2, result] = await createStoreWithSchema(graphV2, backend);
  expect(result.status).toBe("migrated");

  // Run backfill
  const people = await storeV2.query(PersonV2WithBothFields).execute();
  for (const person of people) {
    await storeV2.nodes.Person.update(person.id, {
      fullName: person.properties.name,
    });
  }

  // Verify
  const updated = await storeV2.query(PersonV2WithBothFields).execute();
  expect(updated[0].properties.fullName).toBe("Alice");
});
```

### Previewing Changes Without Applying

Use `getSchemaChanges()` to see what would change without modifying the database:

```typescript
import { getSchemaChanges } from "@nicia-ai/typegraph/schema";

const diff = await getSchemaChanges(backend, newGraph);
if (diff?.hasChanges) {
  console.log("Pending changes:", diff.summary);
  console.log("Breaking:", diff.hasBreakingChanges);

  for (const change of diff.nodes) {
    console.log(`  ${change.severity}: ${change.details}`);
  }
}
```

## Version History

TypeGraph preserves all schema versions in the `typegraph_schema_versions`
table. Only one version is active at a time.

```text
typegraph_schema_versions
├── version 1 (initial)           ← inactive
├── version 2 (added email)       ← inactive
├── version 3 (added Company)     ← active
```

Access version history through the backend:

```typescript
// Get a specific version
const v1 = await backend.getSchemaVersion("my_app", 1);
console.log("V1 created at:", v1?.created_at);

// Get the active version
const active = await backend.getActiveSchema("my_app");
console.log("Current version:", active?.version);
```

## Summary: Change Classification

| Change                         | Classification | Auto-Migrated? |
| ------------------------------ | -------------- | -------------- |
| Add node type                  | Safe           | Yes            |
| Add edge type                  | Safe           | Yes            |
| Add optional property          | Safe           | Yes            |
| Add ontology relation          | Safe           | Yes            |
| Add required property          | Breaking       | No             |
| Remove property                | Breaking       | No             |
| Remove node/edge type          | Breaking       | No             |
| Rename node/edge type          | Breaking       | No             |
| Change property type           | Breaking       | No             |
| Change onDelete behavior       | Warning        | Yes            |
| Change unique constraints      | Warning        | Yes            |
| Change edge cardinality        | Warning        | Yes            |
| Change edge endpoint kinds     | Warning        | Yes            |

## Rollback

If a deployment goes wrong, you can switch back to a previous schema version.
Version history is always preserved — `rollbackSchema()` simply changes which
version is active.

```typescript
import { rollbackSchema } from "@nicia-ai/typegraph/schema";

// Roll back to version 2
await rollbackSchema(backend, "my_app", 2);
```

This does not delete newer versions. You can migrate forward again later.

## Migration Hooks

Use `onBeforeMigrate` and `onAfterMigrate` for observability — logging,
metrics, and alerts during schema migrations:

```typescript
const [store, result] = await createStoreWithSchema(graph, backend, {
  onBeforeMigrate: (context) => {
    console.log(`Migrating ${context.graphId} v${context.fromVersion} → v${context.toVersion}`);
    console.log("Changes:", context.diff.summary);
  },
  onAfterMigrate: (context) => {
    console.log(`Migration complete: v${context.toVersion}`);
    metrics.increment("schema_migrations_total");
  },
});
```

For data transformations (backfill scripts), run them explicitly after store
creation rather than inside hooks. This gives you control over retries and
error handling:

```typescript
const [store, result] = await createStoreWithSchema(graph, backend);

if (result.status === "migrated" && result.toVersion === 3) {
  // Backfill fullName from name for the expand phase
  const people = await store.query(Person).execute();
  for (const person of people) {
    if (!person.properties.fullName) {
      await store.nodes.Person.update(person.id, {
        fullName: person.properties.name,
      });
    }
  }
}
```

## Current Limitations

- **No automatic data transformation.** TypeGraph tracks schema metadata
  changes but does not transform existing rows. Use backfill scripts (or
  `onAfterMigrate` hooks) for data migration.
- **No rename detection.** Renaming a property looks like a removal + addition.
  Use the expand-contract pattern instead.
- **Schema-level only.** Migrations operate on the graph definition, not on
  underlying database tables. TypeGraph's storage tables are
  schema-agnostic (nodes and edges are stored as JSON properties), so
  "schema migration" means updating the metadata that TypeGraph tracks, not
  running `ALTER TABLE`.
