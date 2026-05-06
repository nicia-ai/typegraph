/**
 * Tests for `store.materializeIndexes()`.
 *
 * The verb runs `CREATE INDEX` DDL declared via `defineGraph({ indexes })`
 * (and, transitively, runtime-declared indexes once they flow into the
 * channel). Status is recorded per-database in
 * `typegraph_index_materializations`.
 *
 * Backend coverage here is SQLite-only. Postgres-specific behavior
 * (CONCURRENTLY, no AccessExclusiveLock, two-instance race) lives in
 * `tests/backends/postgres/materialize-indexes.test.ts`.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { tables as defaultSqliteTables } from "../src/backend/drizzle/schema/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { defineGraph } from "../src/core/define-graph";
import { defineNode } from "../src/core/node";
import { ConfigurationError } from "../src/errors";
import { defineNodeIndex } from "../src/indexes";
import { createStore, createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({
    email: z.email(),
    name: z.string(),
    isActive: z.boolean().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

function buildGraph() {
  const personEmail = defineNodeIndex(Person, { fields: ["email"] });
  const personName = defineNodeIndex(Person, { fields: ["name"] });
  const companyName = defineNodeIndex(Company, { fields: ["name"] });
  return defineGraph({
    id: "materialize_test",
    nodes: { Person: { type: Person }, Company: { type: Company } },
    edges: {},
    indexes: [personEmail, personName, companyName],
  });
}

describe("Store.materializeIndexes — basic flow", () => {
  it("creates declared indexes and reports per-index status", async () => {
    const backend = createTestBackend();
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    const result = await store.materializeIndexes();

    expect(result.results).toHaveLength(3);
    for (const entry of result.results) {
      expect(entry.status).toBe("created");
      expect(entry.error).toBeUndefined();
    }
  });

  it("is idempotent: a second call reports alreadyMaterialized for each index", async () => {
    const backend = createTestBackend();
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    await store.materializeIndexes();
    const second = await store.materializeIndexes();

    for (const entry of second.results) {
      expect(entry.status).toBe("alreadyMaterialized");
    }
  });

  it("filters by kind", async () => {
    const backend = createTestBackend();
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    const result = await store.materializeIndexes({ kinds: ["Person"] });

    expect(result.results).toHaveLength(2);
    for (const entry of result.results) {
      expect(entry.kind).toBe("Person");
      expect(entry.status).toBe("created");
    }
  });

  it("throws MATERIALIZE_UNKNOWN_KIND for an unknown kind name", async () => {
    const backend = createTestBackend();
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    const caught = await store
      .materializeIndexes({ kinds: ["NotARealKind"] })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).details).toMatchObject({
      code: "MATERIALIZE_UNKNOWN_KIND",
    });
  });

  it("throws MATERIALIZE_BEFORE_INITIALIZE if the store has no schema yet", async () => {
    const backend = createTestBackend();
    const graph = buildGraph();
    const store = createStore(graph, backend);

    const caught = await store
      .materializeIndexes()
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).details).toMatchObject({
      code: "MATERIALIZE_BEFORE_INITIALIZE",
    });
  });
});

describe("Store.materializeIndexes — status table", () => {
  it("records one row per declared index, keyed on index_name", async () => {
    const { db, backend } = createLocalSqliteBackend();
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    await store.materializeIndexes();

    const rows = await db
      .select()
      .from(defaultSqliteTables.indexMaterializations);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.graphId).toBe(graph.id);
      expect(row.signature).toMatch(/^[0-9a-f]+$/);
      expect(row.materializedAt).not.toBeNull();
      expect(row.lastError).toBeNull();
    }
    await backend.close();
  });

  it("preserves materializedAt across a later failure on the same index", async () => {
    const { db, backend } = createLocalSqliteBackend();
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    await store.materializeIndexes();
    const [firstRow] = await db
      .select()
      .from(defaultSqliteTables.indexMaterializations)
      .where(eq(defaultSqliteTables.indexMaterializations.kind, "Person"));
    const firstMaterializedAt = firstRow!.materializedAt;
    expect(firstMaterializedAt).not.toBeNull();

    await backend.recordIndexMaterialization!({
      indexName: firstRow!.indexName,
      graphId: graph.id,
      entity: "node",
      kind: "Person",
      signature: firstRow!.signature,
      schemaVersion: firstRow!.schemaVersion,
      attemptedAt: new Date().toISOString(),
      materializedAt: undefined,
      error: "simulated failure",
    });

    const [after] = await db
      .select()
      .from(defaultSqliteTables.indexMaterializations)
      .where(
        eq(
          defaultSqliteTables.indexMaterializations.indexName,
          firstRow!.indexName,
        ),
      );

    expect(after!.materializedAt).toBe(firstMaterializedAt);
    expect(after!.lastError).toBe("simulated failure");
    await backend.close();
  });
});

describe("Store.materializeIndexes — signature drift", () => {
  it("detects signature drift and reports failed without re-creating", async () => {
    const backend = createTestBackend();
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    // Pre-populate a materialization row with a deliberately wrong
    // signature for one of the declared indexes. The next call should
    // see signature drift and surface a failed result without
    // attempting the DDL.
    const declared = graph.indexes![0]!;
    await backend.recordIndexMaterialization!({
      indexName: declared.name,
      graphId: "some_other_graph",
      entity: declared.entity,
      kind: declared.kind,
      signature: "00000000deadbeef",
      schemaVersion: 1,
      attemptedAt: new Date().toISOString(),
      materializedAt: new Date().toISOString(),
      error: undefined,
    });

    const result = await store.materializeIndexes();
    const drifted = result.results.find(
      (entry) => entry.indexName === declared.name,
    );
    expect(drifted?.status).toBe("failed");
    expect(drifted?.error?.message).toContain("different signature");
    expect(drifted?.error?.message).toContain("some_other_graph");
  });

  it("stopOnError halts on first failure", async () => {
    const backend = createTestBackend();
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    // Drift on the first declared index.
    const declared = graph.indexes![0]!;
    await backend.recordIndexMaterialization!({
      indexName: declared.name,
      graphId: "other",
      entity: declared.entity,
      kind: declared.kind,
      signature: "wrongsignature",
      schemaVersion: 1,
      attemptedAt: new Date().toISOString(),
      materializedAt: new Date().toISOString(),
      error: undefined,
    });

    const result = await store.materializeIndexes({ stopOnError: true });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe("failed");
  });
});

describe("Store.materializeIndexes — legacy DB bootstrap", () => {
  it("creates the status table on first call against a DB missing it", async () => {
    const { db, backend } = createLocalSqliteBackend();
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    // Simulate a legacy DB that has base tables but lacks the new
    // status table.
    db.run(sql`DROP TABLE IF EXISTS "typegraph_index_materializations"`);

    // materializeIndexes must call bootstrapTables before reading;
    // CREATE TABLE IF NOT EXISTS is idempotent so this also covers
    // fresh DBs.
    const result = await store.materializeIndexes();
    expect(result.results.length).toBeGreaterThan(0);
    for (const entry of result.results) {
      expect(entry.status).toBe("created");
    }
    await backend.close();
  });
});

describe("Store.materializeIndexes — empty / no-op cases", () => {
  let backend: ReturnType<typeof createTestBackend>;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("returns an empty result when the graph declares no indexes", async () => {
    const graph = defineGraph({
      id: "no_indexes",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const [store] = await createStoreWithSchema(graph, backend);
    const result = await store.materializeIndexes();
    expect(result.results).toEqual([]);
  });
});
