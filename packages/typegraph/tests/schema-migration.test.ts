/**
 * Schema Migration Tests
 *
 * Tests the schema lifecycle management:
 * - Initialization on first store creation
 * - Validation on store open
 * - Auto-migration for safe changes
 * - Error reporting for breaking changes
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  ensureSchema,
  getActiveSchema,
  getSchemaChanges,
  initializeSchema,
  isSchemaInitialized,
  migrateSchema,
  MigrationError,
} from "../src";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Graphs
// ============================================================

const PersonV1 = defineNode("Person", {
  schema: z.object({
    name: z.string(),
  }),
});

const PersonV2 = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(), // Safe addition - optional field
  }),
});

const PersonV3Breaking = defineNode("Person", {
  schema: z.object({
    fullName: z.string(), // Breaking - renamed required field
    email: z.string().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

function createGraphV1() {
  return defineGraph({
    id: "migration_test",
    nodes: {
      Person: { type: PersonV1 },
    },
    edges: {},
  });
}

function createGraphV2() {
  return defineGraph({
    id: "migration_test",
    nodes: {
      Person: { type: PersonV2 },
    },
    edges: {},
  });
}

function createGraphV2WithEdge() {
  return defineGraph({
    id: "migration_test",
    nodes: {
      Person: { type: PersonV2 },
      Company: { type: Company },
    },
    edges: {
      worksAt: {
        type: worksAt,
        from: [PersonV2],
        to: [Company],
        cardinality: "many",
      },
    },
  });
}

function createGraphV3Breaking() {
  return defineGraph({
    id: "migration_test",
    nodes: {
      Person: { type: PersonV3Breaking },
    },
    edges: {},
  });
}

// ============================================================
// Tests
// ============================================================

describe("Schema Initialization", () => {
  it("initializes schema on first run", async () => {
    const backend = createTestBackend();
    const graph = createGraphV1();

    const [_store, result] = await createStoreWithSchema(graph, backend);

    expect(result.status).toBe("initialized");
    expect((result as { version: number }).version).toBe(1);

    // Verify schema is stored
    const active = await getActiveSchema(backend, graph.id);
    expect(active).toBeDefined();
    expect(active?.version).toBe(1);
    expect(active?.graphId).toBe("migration_test");
  });

  it("isSchemaInitialized returns correct state", async () => {
    const backend = createTestBackend();
    const graph = createGraphV1();

    // Not initialized yet
    expect(await isSchemaInitialized(backend, graph.id)).toBe(false);

    // Initialize
    await initializeSchema(backend, graph);

    // Now initialized
    expect(await isSchemaInitialized(backend, graph.id)).toBe(true);
  });

  it("returns unchanged when schema matches", async () => {
    const backend = createTestBackend();
    const graph = createGraphV1();

    // First initialization
    await createStoreWithSchema(graph, backend);

    // Second call with same graph
    const [, result] = await createStoreWithSchema(graph, backend);

    expect(result.status).toBe("unchanged");
    expect((result as { version: number }).version).toBe(1);
  });
});

describe("Safe Migration", () => {
  it("auto-migrates when adding optional properties", async () => {
    const backend = createTestBackend();

    // Initialize with v1
    const graphV1 = createGraphV1();
    await createStoreWithSchema(graphV1, backend);

    // Open with v2 (added optional email field)
    const graphV2 = createGraphV2();
    const [, result] = await createStoreWithSchema(graphV2, backend);

    expect(result.status).toBe("migrated");
    const migrated = result as {
      fromVersion: number;
      toVersion: number;
      diff: { hasBreakingChanges: boolean };
    };
    expect(migrated.fromVersion).toBe(1);
    expect(migrated.toVersion).toBe(2);
    expect(migrated.diff.hasBreakingChanges).toBe(false);

    // Verify version updated
    const active = await getActiveSchema(backend, graphV2.id);
    expect(active?.version).toBe(2);
  });

  it("auto-migrates when adding new node types", async () => {
    const backend = createTestBackend();

    // Initialize with v2
    const graphV2 = createGraphV2();
    await createStoreWithSchema(graphV2, backend);

    // Open with v2+edge (added Company node and worksAt edge)
    const graphWithEdge = createGraphV2WithEdge();
    const [, result] = await createStoreWithSchema(graphWithEdge, backend);

    expect(result.status).toBe("migrated");
    const migrated = result as unknown as {
      diff: {
        nodes: { type: string; name: string }[];
        edges: { type: string; name: string }[];
      };
    };
    expect(
      migrated.diff.nodes.some(
        (n) => n.type === "added" && n.name === "Company",
      ),
    ).toBe(true);
    expect(
      migrated.diff.edges.some(
        (edge) => edge.type === "added" && edge.name === "worksAt",
      ),
    ).toBe(true);
  });

  it("preserves schema history", async () => {
    const backend = createTestBackend();

    // Initialize with v1
    const graphV1 = createGraphV1();
    await createStoreWithSchema(graphV1, backend);

    // Check v1 is active before migration
    const v1Before = await backend.getSchemaVersion(graphV1.id, 1);
    expect(v1Before?.is_active).toBe(true);

    // Migrate to v2
    const graphV2 = createGraphV2();
    await createStoreWithSchema(graphV2, backend);

    // Both versions should exist in database
    const v1 = await backend.getSchemaVersion(graphV2.id, 1);
    const v2 = await backend.getSchemaVersion(graphV2.id, 2);

    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    expect(v2?.is_active).toBe(true);
    // Note: v1 should now be inactive after setActiveSchema was called for v2
    expect(v1?.is_active).toBe(false);
  });

  it("setActiveSchema deactivates previous versions", async () => {
    const backend = createTestBackend();

    // Initialize with v1
    const graphV1 = createGraphV1();
    await initializeSchema(backend, graphV1);

    // Check v1 is active
    const v1Before = await backend.getSchemaVersion(graphV1.id, 1);
    expect(v1Before?.is_active).toBe(true);

    // Migrate to v2
    const graphV2 = createGraphV2();
    await migrateSchema(backend, graphV2, 1);

    // Now check both versions
    const v1 = await backend.getSchemaVersion(graphV1.id, 1);
    const v2 = await backend.getSchemaVersion(graphV2.id, 2);

    // After migration, v1 should be inactive and v2 active
    expect(v1?.is_active).toBe(false);
    expect(v2?.is_active).toBe(true);
  });
});

describe("Breaking Changes", () => {
  it("throws MigrationError for breaking changes by default", async () => {
    const backend = createTestBackend();

    // Initialize with v1
    const graphV1 = createGraphV1();
    await createStoreWithSchema(graphV1, backend);

    // Try to open with breaking changes
    const graphBreaking = createGraphV3Breaking();

    await expect(createStoreWithSchema(graphBreaking, backend)).rejects.toThrow(
      MigrationError,
    );
  });

  it("includes migration actions in error", async () => {
    const backend = createTestBackend();

    // Initialize with v1
    const graphV1 = createGraphV1();
    await createStoreWithSchema(graphV1, backend);

    // Try to open with breaking changes
    const graphBreaking = createGraphV3Breaking();

    await expect(createStoreWithSchema(graphBreaking, backend)).rejects.toThrow(
      /Schema migration required/,
    );
  });

  it("returns breaking status when throwOnBreaking is false", async () => {
    const backend = createTestBackend();

    // Initialize with v1
    const graphV1 = createGraphV1();
    await createStoreWithSchema(graphV1, backend);

    // Open with breaking changes, but don't throw
    const graphBreaking = createGraphV3Breaking();
    const result = await ensureSchema(backend, graphBreaking, {
      throwOnBreaking: false,
    });

    expect(result.status).toBe("breaking");
    const breaking = result as unknown as {
      diff: { hasBreakingChanges: boolean };
      actions: unknown[];
    };
    expect(breaking.diff.hasBreakingChanges).toBe(true);
    expect(breaking.actions.length).toBeGreaterThan(0);
  });
});

describe("Schema Changes Detection", () => {
  it("getSchemaChanges returns diff for pending changes", async () => {
    const backend = createTestBackend();

    // Initialize with v1
    const graphV1 = createGraphV1();
    await createStoreWithSchema(graphV1, backend);

    // Check changes against v2
    const graphV2 = createGraphV2();
    const diff = await getSchemaChanges(backend, graphV2);

    expect(diff).toBeDefined();
    expect(diff?.hasChanges).toBe(true);
  });

  it("getSchemaChanges returns undefined for uninitialized graph", async () => {
    const backend = createTestBackend();

    const graph = createGraphV1();
    const diff = await getSchemaChanges(backend, graph);

    expect(diff).toBeUndefined();
  });
});

describe("Migration Options", () => {
  it("autoMigrate=false skips migration", async () => {
    const backend = createTestBackend();

    // Initialize with v1
    const graphV1 = createGraphV1();
    await createStoreWithSchema(graphV1, backend);

    // Open with v2 but autoMigrate=false
    const graphV2 = createGraphV2();
    const result = await ensureSchema(backend, graphV2, { autoMigrate: false });

    // Should still detect changes but not migrate
    expect(result.status).toBe("migrated"); // Status says it would migrate
    // But version didn't change
    const migrated = result as { fromVersion: number; toVersion: number };
    expect(migrated.fromVersion).toBe(1);
    expect(migrated.toVersion).toBe(1);

    // Schema version should still be 1
    const active = await getActiveSchema(backend, graphV2.id);
    expect(active?.version).toBe(1);
  });

  it("manual migrateSchema works", async () => {
    const backend = createTestBackend();

    // Initialize with v1
    const graphV1 = createGraphV1();
    await initializeSchema(backend, graphV1);

    // Manually migrate to v2
    const graphV2 = createGraphV2();
    const newVersion = await migrateSchema(backend, graphV2, 1);

    expect(newVersion).toBe(2);

    const active = await getActiveSchema(backend, graphV2.id);
    expect(active?.version).toBe(2);
  });
});
